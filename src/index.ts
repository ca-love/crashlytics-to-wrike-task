#!/usr/bin/env node

import fs from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import axios, { AxiosResponse } from "axios";
import * as core from "@actions/core";

const ESCAPE_REGEXP = /\$(\$[^$]+)/g;
const PLACEHOLDER_REGEXP = /\$([^$]+)/g;
const PLACEHOLDER_REGEXP_BRACE = /\$\{([^${}]+)\}/g;
const axiosClient = axios.create({
  baseURL: 'https://www.wrike.com/api/v4',
  headers: {
    'Content-Type': 'application/json',
  },
  responseType: 'json'
});

interface WrikeConfig {
  accessToken: string;
  folderId: string;
  notCompletedWorkflowStatusIds: Array<string>;
  crashlyticsIssueIdFieldId: string;
  todoWorkflowStatusId: string;
  fixedOrIgnoreFlagFieldId: string;
}

interface CrashlyticsConfig {
  gcpProjectId: string;
  tableName: string;
  issueBaseUrl: string;
}

interface SlackNotifyConfig {
  notifySlackUrl: string;
}

interface CrashlyticsAnalysisConfig {
  slackNotifyConfig: SlackNotifyConfig;
  crashlyticsConfig: CrashlyticsConfig;
  wrikeConfig: WrikeConfig;
}

interface CrashlyticsIssue {
  count: number;
  isFatal: boolean;
  id: string;
  title: string;
  exceptionType: string;
  exceptionMessage: string;
}

interface WrikeTasksResult {
  kind: string;
  data: Array<any>;
}

function readConfig(configPath: string) {
  const configJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return expandPlaceholders(configJson) as CrashlyticsAnalysisConfig;
}

function expandPlaceholders(x: any): any {
  if (typeof x === "object") {
    Object.keys(x).forEach(k => {
      x[k] = expandPlaceholders(x[k]);
    });
    return x;
  } else if (Array.isArray(x)) {
    return x.map(() => expandPlaceholders(x));
  } else if (typeof x === "string") {
    if (ESCAPE_REGEXP.test(x)) {
      return x.replace(ESCAPE_REGEXP, (_, g1) => g1);
    } else if (PLACEHOLDER_REGEXP_BRACE.test(x)) {
      return x.replace(PLACEHOLDER_REGEXP_BRACE, (_, g1) => process.env[g1] as string);
    } else if (PLACEHOLDER_REGEXP.test(x)) {
      return x.replace(PLACEHOLDER_REGEXP, (_, g1) => process.env[g1] as string);
    } else {
      return x;
    }
  } else {
    return x;
  }
}

async function readCrashlyticsReportTable(config: CrashlyticsConfig) {
  const bigquery = new BigQuery({
    projectId: config.gcpProjectId
  });

  const targetDate = core.getInput("target_date")
  var placeHolder: string
  if (targetDate) {
    placeHolder = `@targetDate`
  } else {
    placeHolder = `FORMAT_DATE("%Y%m%d", CURRENT_DATE('Asia/Tokyo') - 1)`
  }

  const [results] = await bigquery.query({
    query: `
      WITH issue_count AS (
          SELECT
              count(*) as count, issue_id
          FROM
              \`firebase_crashlytics.${config.tableName}\`
          WHERE
              FORMAT_DATE("%Y%m%d", event_timestamp) = ${placeHolder}
          group by issue_id
      ),
      issues AS (
          SELECT
              DISTINCT issue_id,
              issue_title,
              is_fatal,
              exceptions.type as exception_type,
              exceptions.exception_message as exception_message
          FROM 
              \`firebase_crashlytics.${config.tableName}\`,
              UNNEST(exceptions) as exceptions
          WHERE
              FORMAT_DATE("%Y%m%d", event_timestamp) = ${placeHolder}
      )
      
      SELECT
          issue_count.count as count,
          issues.issue_id as id,
          issues.issue_title as title,
          issues.is_fatal as isFatal,
          issues.exception_type as exceptionType,
          issues.exception_message as exceptionMessage
      FROM
          issue_count 
      INNER JOIN
          issues
      ON
          issue_count.issue_id = issues.issue_id
      WHERE
          issues.is_fatal = true
      ORDER BY count DESC
      LIMIT 20
    `,
    params: { targetDate }
  });
  return results as Array<CrashlyticsIssue>;
}

async function findWrikeTasks(config: WrikeConfig, issues: Array<CrashlyticsIssue>) {
  return Promise.all(issues.map(async (issue) => {
    const res: AxiosResponse = await axiosClient.get(`/folders/${config.folderId}/tasks`, {
      headers: {
        "Authorization": `bearer ${config.accessToken}`
      },
      params: {
        "pageSize": 20,
        "nextPageToken": null,
        "fields": '["customFields"]',
        "customField": {
          "id": config.crashlyticsIssueIdFieldId,
          "comparator": "EqualTo",
          "value": `${issue.id}`
        }
      }
    });
    return res.data.data;
  }));
}

async function createWrikeTask(config: WrikeConfig, issue: CrashlyticsIssue, crashlyticsBaseUrl: string) {
  return await axiosClient.post(`/folders/${config.folderId}/tasks`, {
    "title": `${issue.exceptionType}(${issue.exceptionMessage}) ${issue.title}`,
    "description": `${crashlyticsBaseUrl}${issue.id}\n`,
    "customFields": [
      {
        "id": config.crashlyticsIssueIdFieldId,
        "value": `${issue.id}`
      }
    ]
  }, {
    headers: {
      "Authorization": `bearer ${config.accessToken}`
    }
  });
}

async function toTodoStatusWrikeTask(config: WrikeConfig, task: any) {
  return await axiosClient.put(`/tasks/${task.id}`, {
    "customStatus": config.todoWorkflowStatusId
  }, {
    headers: {
      "Authorization": `bearer ${config.accessToken}`
    }
  });
}

async function registerWrike(config: CrashlyticsAnalysisConfig, issues: Array<CrashlyticsIssue>) {
  const tasks = await findWrikeTasks(config.wrikeConfig, issues);
  return Promise.all(tasks.map(async (tasks, index) => {
    // issueIdに紐づくtaskは基本一つ
    const task = tasks[0];
    if (task) {
      // 修正済み/無視することにしたtaskは更新しない
      const customFilelds = task.customFields.reduce((acc: any, v: any, _: any) => {
        acc[v.id] = v.value
        return acc
      }, {});
      const fixedOrIgnore = customFilelds[config.wrikeConfig.fixedOrIgnoreFlagFieldId] == "true"
      const regression = config.wrikeConfig.notCompletedWorkflowStatusIds.indexOf(task.customStatusId) == -1
      // Todoで上書きするようにする
      if (!fixedOrIgnore && regression) {
        const res = await toTodoStatusWrikeTask(config.wrikeConfig, task);
      }
    } else {
      // 無いので作成
      await createWrikeTask(config.wrikeConfig, issues[index], config.crashlyticsConfig.issueBaseUrl);
    }
  }));
}

async function notifySlack(config: SlackNotifyConfig, issueBaseUrl: string, issues: Array<CrashlyticsIssue>) {
  const text = issues.map((issue, index) => {
    var isFatal = ""
    if (issue.isFatal) isFatal = "Fatal Issue "
    return `${index + 1}. ${isFatal}${issue.count} Events. ${issue.exceptionType}(${issue.exceptionMessage})<${issueBaseUrl}${issue.id}|${issue.title}>`
  })
    .join('\n');

  return axiosClient.post(config.notifySlackUrl, {
    text: `昨日起こったクラッシュイベント(上位)\n${text}`
  });
}

async function cli() {
  const config = readConfig(core.getInput('config_path'));
  const issues = await readCrashlyticsReportTable(config.crashlyticsConfig);
  await registerWrike(config, issues);
  await notifySlack(config.slackNotifyConfig, config.crashlyticsConfig.issueBaseUrl, issues);
  return Promise.resolve();
}

console.log("cli start");
cli()
  .then(() => {
    console.log("cli success");
  })
  .catch((reason) => {
    console.error("cli error", reason);
    core.setFailed(reason.message);
  });
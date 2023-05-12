#!/usr/bin/env node

import fs from 'fs'
import { BigQuery } from '@google-cloud/bigquery'
import axios, { type AxiosResponse } from 'axios'
import * as core from '@actions/core'

const ESCAPE_REGEXP = /\$(\$[^$]+)/g
const PLACEHOLDER_REGEXP = /\$([^$]+)/g
const PLACEHOLDER_REGEXP_BRACE = /\$\{([^${}]+)\}/g
const axiosClient = axios.create({
  baseURL: 'https://www.wrike.com/api/v4',
  headers: {
    'Content-Type': 'application/json'
  },
  responseType: 'json'
})

interface WrikeConfig {
  accessToken: string
  folderId: string
  notCompletedWorkflowStatusIds: string[]
  crashlyticsIssueIdFieldId: string
  todoWorkflowStatusId: string
  fixedOrIgnoreFlagFieldId: string
}

interface CrashlyticsConfig {
  gcpProjectId: string
  tableName: string
  issueBaseUrl: string
}

interface SlackNotifyConfig {
  notifySlackUrl: string
}

interface CrashlyticsAnalysisConfig {
  slackNotifyConfig: SlackNotifyConfig
  crashlyticsConfig: CrashlyticsConfig
  wrikeConfig: WrikeConfig
}

interface CrashlyticsIssue {
  eventTime: string
  count: number
  id: string
  title: string
  exceptionType: string
  exceptionMessage: string
}

function readConfig (configPath: string): CrashlyticsAnalysisConfig {
  const configJson = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  return expandPlaceholders(configJson) as CrashlyticsAnalysisConfig
}

function expandPlaceholders (x: any): any {
  if (typeof x === 'object') {
    Object.keys(x).forEach(k => {
      x[k] = expandPlaceholders(x[k])
    })
    return x
  } else if (Array.isArray(x)) {
    return x.map(() => expandPlaceholders(x))
  } else if (typeof x === 'string') {
    if (ESCAPE_REGEXP.test(x)) {
      return x.replace(ESCAPE_REGEXP, (_, g1) => g1)
    } else if (PLACEHOLDER_REGEXP_BRACE.test(x)) {
      return x.replace(PLACEHOLDER_REGEXP_BRACE, (_, g1) => process.env[g1] as string)
    } else if (PLACEHOLDER_REGEXP.test(x)) {
      return x.replace(PLACEHOLDER_REGEXP, (_, g1) => process.env[g1] as string)
    } else {
      return x
    }
  } else {
    return x
  }
}

async function readCrashlyticsReportTable (config: CrashlyticsConfig): Promise<CrashlyticsIssue[]> {
  const bigquery = new BigQuery({
    projectId: config.gcpProjectId
  })

  const targetDate = core.getInput('target_date')
  let placeHolder: string
  if (targetDate !== undefined) {
    placeHolder = '@targetDate'
  } else {
    // 実行時の関係で昨日のimportされてないケースがある
    placeHolder = 'FORMAT_DATE("%Y%m%d", CURRENT_DATE(\'Asia/Tokyo\') - 2)'
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
              exceptions.type as exception_type,
              exceptions.exception_message as exception_message,
              FORMAT_DATE("%Y-%m-%d", event_timestamp) as event_time
          FROM 
              \`firebase_crashlytics.${config.tableName}\`,
              UNNEST(exceptions) as exceptions
          WHERE
              FORMAT_DATE("%Y%m%d", event_timestamp) = ${placeHolder}
          AND
              error_type = 'FATAL'
      )
      
      SELECT
          issues.event_time as eventTime,
          issue_count.count as count,
          issues.issue_id as id,
          issues.issue_title as title,
          issues.exception_type as exceptionType,
          issues.exception_message as exceptionMessage
      FROM
          issue_count 
      INNER JOIN
          issues
      ON
          issue_count.issue_id = issues.issue_id
      ORDER BY count DESC
      LIMIT 100
    `,
    params: { targetDate }
  })
  return results as CrashlyticsIssue[]
}

async function findWrikeTasks (config: WrikeConfig, issues: CrashlyticsIssue[]): Promise<any[]> {
  return await Promise.all(issues.map(async (issue) => {
    const res: AxiosResponse = await axiosClient.get(`/folders/${config.folderId}/tasks`, {
      headers: {
        Authorization: `bearer ${config.accessToken}`
      },
      params: {
        pageSize: 20,
        nextPageToken: null,
        fields: '["customFields"]',
        customField: `{ "id": "${config.crashlyticsIssueIdFieldId}", "comparator":"EqualTo", "value":"${issue.id}" }`
      }
    })
    return res.data.data
  }))
}

async function createWrikeTask (config: WrikeConfig, issue: CrashlyticsIssue, crashlyticsBaseUrl: string): Promise<AxiosResponse> {
  return await axiosClient.post(`/folders/${config.folderId}/tasks`, {
    title: `${issue.exceptionType}(${issue.exceptionMessage}) ${issue.title}`,
    description: `${crashlyticsBaseUrl}${issue.id}\n`,
    customFields: [
      {
        id: config.crashlyticsIssueIdFieldId,
        value: `${issue.id}`
      }
    ]
  }, {
    headers: {
      Authorization: `bearer ${config.accessToken}`
    }
  })
}

async function toTodoStatusWrikeTask (config: WrikeConfig, task: any): Promise<AxiosResponse> {
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  return await axiosClient.put(`/tasks/${task.id}`, {
    customStatus: config.todoWorkflowStatusId
  }, {
    headers: {
      Authorization: `bearer ${config.accessToken}`
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function registerWrike (config: CrashlyticsAnalysisConfig, issues: CrashlyticsIssue[]): Promise<any[]> {
  const tasks = await findWrikeTasks(config.wrikeConfig, issues)
  return await Promise.all(tasks.map(async (tasks, index) => {
    // issueIdに紐づくtaskは基本一つ
    const task = tasks[0]
    if (task !== undefined) {
      // 修正済み/無視することにしたtaskは更新しない
      let customFields
      if (task.customFields !== undefined) {
        customFields = task.customFields.reduce((acc: any, v: any, _: any) => {
          acc[v.id] = v.value
          return acc
        }, {})
      } else {
        customFields = {}
      }
      const fixedOrIgnore = customFields[config.wrikeConfig.fixedOrIgnoreFlagFieldId] === 'true'
      const regression = !config.wrikeConfig.notCompletedWorkflowStatusIds.includes(task.customStatusId)
      // Todoで上書きするようにする
      if (!fixedOrIgnore && regression) {
        await toTodoStatusWrikeTask(config.wrikeConfig, task)
      }
    } else {
      // 無いので作成
      await createWrikeTask(config.wrikeConfig, issues[index], config.crashlyticsConfig.issueBaseUrl)
    }
  }))
}

async function notifySlack (config: SlackNotifyConfig, issueBaseUrl: string, issues: CrashlyticsIssue[]): Promise<AxiosResponse> {
  const data: any = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '起こったイベント'
        }
      }
    ]
  }

  if (issues.length === 0) {
    data.blocks.push({
      type: 'section',
      text: {
        type: 'plain_text',
        text: 'なし'
      }
    })
  } else {
    const ids: any = {}
    issues
      .filter((issue: CrashlyticsIssue, index: number) => {
        if (ids[issue.id] === undefined) {
          ids[issue.id] = true
          return true
        } else {
          return false
        }
      })
      .forEach((issue, index) => {
        data.blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${issue.eventTime} .Count: ${issue.count}. ${issue.exceptionType}(${encodeURI(issue.exceptionMessage)})`
          },
          accessory: {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View'
            },
            url: `${issueBaseUrl}${issue.id}`
          }
        })
      })
  }

  return await axiosClient.post(config.notifySlackUrl, data)
}

async function cli (): Promise<void> {
  const config = readConfig(core.getInput('config_path'))
  const issues = await readCrashlyticsReportTable(config.crashlyticsConfig)
  // await registerWrike(config, issues)
  await notifySlack(config.slackNotifyConfig, config.crashlyticsConfig.issueBaseUrl, issues)
  await Promise.resolve()
}

console.log('cli start')
cli()
  .then(() => {
    console.log('cli success')
  })
  .catch((reason) => {
    console.error('cli error', reason)
    core.setFailed(reason.message)
  })

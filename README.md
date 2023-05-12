## 環境
node v16

## リリース手順
nccを使っています。nccをインストールした上で下のコマンドを順番に実行する

- npm install
- npm run publish

出力されたlib/index.jsを含めてcommit.
リリースするcommitでタグをきる。使う側はそのタグを指定して利用する。

## 使い方
GitHub Actionsで実行することを想定しています。

workflow.ymlの書き方 => [workflow](.github/workflows/import-crash-to-wrike.yml)

`WRIKE_TOKEN`: チケットの更新を行うWrikeのアカウント. アカウント -> アプリ&連携 -> APIで作成、Tokenの発行で作成したトークン.

`config_path`: 実行するための設定値。 リグレッションと判断するために解決済みとしているworkflowのstatusIdなど。下記に詳細を示す。

Workflowのid, statusIdは画面上でわからないのでAPIを実行して参照する.

https://developers.wrike.com/api/v4/workflows/#query-workflows

```
{
  "slackNotifyConfig": {
    "notifySlackUrl": slackのwebhookUrl. 取り込んだログのサマリーが通知される。
  },
  "crashlyticsConfig": {
    "gcpProjectId": GCPのprojectId,
    "tableName": Crashlyticsのログを保存しているBigQueryのtableName,
    "issueBaseUrl": Firebase Crashlyticsのログ詳細のURL. issueIdのみ参照できるのでチケットにリンクを追記する際に使われる。 
  },
  "wrikeConfig": {
    "accessToken": "${WRIKE_TOKEN}", この記載で環境変数から読み込んだものに置き換えれて実行される
    "folderId": Crashlyticsのログをチケットして保存するWrikeのfolderId,
    "notCompletedWorkflowStatusIds": [ ], 作業中にあたるWrikeのWorkflowのステータスID. このstatusIdのチケットは更新されない
    "crashlyticsIssueIdFieldId": CrashlyticsのissueIdのためのカスタムフィールドのId,
    "todoWorkflowStatusId": notCompletedWorkflowStatusIdsで指定されているstatus以外のチケットで、Crashlyticsに記録された際の移動先statusId,
    "fixedOrIgnoreFlagFieldId": booleanのカスタムフィールドとして定義してください. trueの場合にチケットが更新されない
  }
}
```


## 環境
node v12

## リリース手順
nccを使っています。nccをインストールした上で下のコマンドを順番に実行する

- npm install
- npm run prepublish
- ncc build lib/index.js --license license.txt

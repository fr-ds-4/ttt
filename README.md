# CircleCI Free 預約流程測試

1. 建立 GitHub 私有儲存庫，把本 ZIP 解壓後的 `.circleci/config.yml`、`run.mjs` 和本說明上傳到儲存庫根目錄。
2. 到 CircleCI 建立 Free 專案，以 GitHub App 連接該儲存庫。
3. 在 Project Settings → Environment Variables 新增 `TEST_URL`，值填有測試權限且可由 CircleCI 連線的 HTTPS 測試頁網址。網址不預填。
4. 手動執行 main 分支一次。預設送出最多一筆。到工作頁的 Artifacts 開啟 `results/registration.jsonl` 檢查網站實際回覆。
5. 確認流程後，新增 `MAX_CASES=0`，啟用按時間執行的模式。到 Project Settings → Project Setup，在對應 Pipeline 旁按 Schedule +，選 main、每日、每小時一次。初次排程以 CircleCI 顯示的時區為準。
6. 停止未來執行可停用或刪除排程。執行中的工作可從工作流程頁面取消。

| CircleCI 變數 | 預設值 | 說明 |
|---|---|---|
| TEST_URL | 必填 | 授權測試頁的 HTTPS URL |
| MAX_CASES | 1 | 正整數可指定每次上限，0 依時間執行 |
| RUN_SECONDS | 360 | 每次開始新一筆的時間預算，範圍 1～600 秒。已開始的一筆可能稍晚才結束 |

每筆結果後等待 2 秒。若結果不明、網站限流或操作失敗，本次工作會停止。每次工作各自保存 JSONL。下次排程會啟動新的測試批次。

隨機碼可用於驗證表單與驗證規則。若系統只接受已存在的代碼，隨機猜測通常只會得到驗證失敗。要測試成功寫入，請改用測試環境中已配置且可使用的代碼。網站回覆筆數與實際寫入筆數請分開看。

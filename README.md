# Playwright 自動化工具

將此 ZIP 解壓後，把內部檔案上傳至 GitHub 專案根目錄。請保留檔名以點開頭的設定檔。

## Hostless

1. 在 Project 的 Workers 建立 Standalone Worker，選擇此 GitHub repository 和部署分支。
2. Working Directory 填 /。Build System 選 Docker，Dockerfile Path 填 Dockerfile。
3. Start Command 留空即可使用 Dockerfile 的 CMD。若介面要求填寫，輸入 node start-wispbyte.js。
4. 先使用 1 個 instance。此背景程式不需要 HOST、PORT 或 HTTP 健康檢查。
5. 在環境變數填入 TEST_URL（你有權測試的 HTTPS 測試頁）、MAX_CASES=1、RUN_SECONDS=120。其他設定可參考 .env.example。
6. 部署後查看 Runtime Logs。opening_page、page_response、form_ready 和 summary 分別標示開頁、回應、表單就緒及執行結束。有限測試到達次數或時間後會結束。

Docker 建置會預裝 Node.js 24、Playwright 1.64.1、Chromium Headless Shell 和 Linux 系統依賴。程式會將日誌寫到 stdout，並嘗試寫入 results/registration.jsonl。

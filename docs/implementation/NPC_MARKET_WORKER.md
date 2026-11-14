# Vận hành NPC thu mua trên testnet

Worker chạy một lượt qua lệnh:

    node scripts/tick-npc-market.mjs <configuration.json> <persistent-jobs.sqlite>

Bật bằng `VEILBOUND_NPC_MARKET_ENABLED=true`. Cấu hình `VEILBOUND_NPC_SIGNER_URL` trỏ đến dịch vụ ký HTTPS do người vận hành quản lý và cấp `VEILBOUND_NPC_SIGNER_TOKEN` qua môi trường của tiến trình. Giữ nguyên tệp SQLite cho cùng tài khoản. Nếu lập lịch, gọi lại lệnh với cùng cấu hình và tệp này.

Trên máy phát triển, đặt `VEILBOUND_NPC_SIGNER_MODE=local` để dùng khóa vận hành NPC trong thư mục bí mật của VEILBOUND. Worker có thể chạy lặp bằng cách truyền thêm khoảng cách giữa hai lượt, tính theo mili giây. Ví dụ:

    node scripts/tick-npc-market.mjs <configuration.json> <persistent-jobs.sqlite> 30000

Dùng cùng tệp SQLite để giữ cam kết vốn và nhận diện lệnh chưa rõ kết quả qua các lần chạy. Worker dừng khi policy hết hạn hoặc khi tiến trình nhận yêu cầu dừng.

Ví dụ cấu hình để thử trên tài khoản riêng đã nạp Copper vào Core. Thay các ID và thời điểm hết hạn theo deployment đang dùng.

```json
{
  "accountId": "npc.example.testnet",
  "coreId": "core.example.testnet",
  "copperId": "copper.example.testnet",
  "ttlMs": 300000,
  "policy": {
    "epoch": 1,
    "expiresAt": 1800000000000,
    "methods": ["buy"],
    "itemIds": ["salt"],
    "maxQuantity": 4,
    "maxUnitPriceAtomic": "100",
    "budgetRemainingAtomic": "400",
    "targetStock": { "salt": 4 }
  },
  "pricing": {
    "salt": { "anchorAtomic": "100", "spreadBps": 1500, "stockImpactBps": 0 }
  }
}
```

Dịch vụ ký nhận POST JSON gồm `accountId`, `operationId` và `transaction`, kèm Bearer token. Dịch vụ phải kiểm tra tài khoản NPC riêng, network testnet, Core receiver, đúng một lệnh `place_market_order` với side `Buy` và 1 yoctoNEAR, trần gas, danh sách vật phẩm và giới hạn chi của chính dịch vụ. Dùng `operationId` làm khóa idempotency. Sau khi gửi, trả JSON `{ "transactionHash": "..." }`. Core yêu cầu 1 yoctoNEAR cho lệnh này, nên access key giới hạn theo method của NEAR không ký được giao dịch hiện tại. Dịch vụ ký và khóa được quản lý riêng, ngoài API game.

Worker lấy số dư và tồn kho từ một block finalized, dùng giá bid theo tồn kho và kiểm tra lại trước khi ký. Core khóa Copper khi đặt lệnh. `budgetRemainingAtomic` là trần tổng giá trị worker cam kết từ khi tạo tệp SQLite, bao gồm lệnh đã xác nhận và lệnh chưa rõ kết quả. Lệnh chưa rõ kết quả được tra lại theo operation ID ở tick sau. NPC giữ tối đa một lệnh thu mua còn hạn hoặc chưa rõ kết quả cho mỗi vật phẩm.

Kết quả JSON có operation ID và trạng thái. Trạng thái `final` có block hash và order ID lấy từ Core. Khi có transaction hash, người vận hành có thể đăng lệnh qua luồng xác minh market hiện có. Core giữ Copper của phần chưa khớp tới khi tài khoản NPC gọi `cancel_market_order`. Việc đăng lệnh lên bảng chợ và hoàn escrow hết hạn hiện do người vận hành thực hiện.

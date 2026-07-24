# Tài liệu Giải pháp: Hoàn thiện Endpoint `POST /api/bookings`


## 1. Sử dụng Database Transaction (Đảm bảo dữ liệu không dở dang)

- **Vấn đề ban đầu:** Hệ thống cũ thực hiện việc thêm bản ghi đặt chỗ (`INSERT bookings`) và trừ số lượng chỗ trống (`UPDATE slots`) thành 2 bước rời rạc. Nếu server sập giữa chừng, có thể dẫn đến việc đã tạo booking nhưng chưa trừ chỗ (dữ liệu bị sai lệch).
- **Cách giải quyết:** Đưa cả 2 câu truy vấn SQL vào trong một `db.transaction()`. Nếu bất kỳ bước nào trong Transaction bị lỗi, SQLite sẽ tự động Rollback (hoàn tác) toàn bộ thao tác, đảm bảo **request thất bại không để lại dữ liệu dở dang**.

## 2. Optimistic Locking (Chống Race Condition - Nhiều người đặt cùng lúc)

- **Vấn đề ban đầu:** Kiểm tra `remaining > 0` bằng một câu `SELECT` trước, sau đó mới gọi hàm `UPDATE`. Nếu có 10 người cùng nhấn "Đặt chỗ" cùng một mili-giây, cả 10 người đều vượt qua bài kiểm tra `SELECT` và cùng làm số chỗ trống bị trừ âm.
- **Cách giải quyết:** Sử dụng kỹ thuật Optimistic Locking. Loại bỏ hoàn toàn bước kiểm tra rời rạc, thay vào đó gắn thẳng điều kiện vào câu lệnh Update:
  ```sql
  UPDATE slots SET remaining = remaining - 1 WHERE id = ? AND remaining > 0
  ```
  Nhờ tính chất Atomic của Database, hệ thống đảm bảo chỉ có đúng 1 người cập nhật thành công (giảm remaining thành 0). 9 người còn lại sẽ nhận về kết quả không cập nhật được hàng nào (`numUpdatedRows === 0`) và hệ thống sẽ trả ra lỗi `409 SLOT_FULL`. Tính nhất quán của số chỗ được đảm bảo tuyệt đối.

## 3. Cơ chế Idempotency (Xử lý Request bị trùng lặp/retry)

- **Vấn đề ban đầu:** Cột `idempotency_key` trong DB đã có sẵn ràng buộc `UNIQUE` (chống trùng). Nếu một Request bị gọi lại (do mạng lag), nó vi phạm ràng buộc này và hệ thống quăng lỗi `500 INTERNAL_ERROR` đứt gãy.
- **Cách giải quyết (Bảo vệ 2 tầng):**
  - **Tầng 1 (Truy vấn trước):** Trước khi làm bất cứ việc gì, query vào DB xem `idempotency_key` đã tồn tại chưa. Nếu có, tức là request này là request trùng lặp → Lập tức trả về `201` kèm chính thông tin booking cũ (không làm thay đổi data).
  - **Tầng 2 (Bắt lỗi Constraint):** Phòng trường hợp 2 request trùng nhau gửi đến quá sát nút, vượt qua được Tầng 1. Một request sẽ chạy vào Transaction bị lỗi Unique, mình đã `catch(error)` và bắt riêng lỗi `"bookings.idempotency_key"` để trả về kết quả 201 an toàn thay vì lỗi 500.

## 4. Phân tách và Xử lý Lỗi Nghiệp Vụ Chuyên Sâu

- **Vấn đề ban đầu:** Các lỗi vi phạm ràng buộc DB đều bị gom chung lại.
- **Cách giải quyết:** 
  Viết thêm hàm `isUniqueConstraintError()` để bóc tách thông báo lỗi do SQLite ném ra:
  - Nếu vi phạm `bookings.idempotency_key` → Xử lý Idempotency (trả về 201).
  - Nếu vi phạm `bookings_user_slot_unique` → Trả về đúng mã lỗi nghiệp vụ `409 ALREADY_BOOKED`.

## Tổng kết

Bằng việc tái cấu trúc hàm `handleCreateBookingRequest`, dự án đã đáp ứng hoàn toàn:
✅ Validation dữ liệu.
✅ Không tạo booking trên resource hết hạn (SLOT_FULL).
✅ Idempotency (Xử lý hợp lý khi request bị retry/trùng lặp).
✅ Consistency (Sử dụng Transaction đảm bảo không để lại dữ liệu dở dang).
✅ Trả lỗi nghiệp vụ nhất quán, không làm sập server.

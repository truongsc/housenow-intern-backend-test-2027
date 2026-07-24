import type { Selectable } from "kysely";
import type {
  AppDatabase,
  BookingTable,
} from "../db";
import { jsonError } from "../errors";

interface CreateBookingBody {
  userId?: unknown;
  slotId?: unknown;
  idempotencyKey?: unknown;
}

type Booking = Selectable<BookingTable>;

function serializeBooking(row: Booking) {
  return {
    id: row.id,
    userId: row.user_id,
    slotId: row.slot_id,
    status: row.status,
  };
}

async function readBody(request: Request): Promise<CreateBookingBody | null> {
  try {
    return (await request.json()) as CreateBookingBody;
  } catch {
    return null;
  }
}

/**
 * Kiểm tra xem một lỗi SQLite có phải là vi phạm UNIQUE constraint hay không.
 * better-sqlite3 ném ra lỗi với message chứa "UNIQUE constraint failed".
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed")
  );
}

export async function handleCreateBookingRequest(
  request: Request,
  db: AppDatabase,
): Promise<Response> {
  // ── 1. Parse & Validate request body ─────────────────────────────────────
  const body = await readBody(request);
  const { userId, slotId, idempotencyKey } = body ?? {};

  if (
    !Number.isInteger(userId) ||
    !Number.isInteger(slotId) ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0
  ) {
    return jsonError(
      400,
      "VALIDATION_ERROR",
      "userId, slotId and idempotencyKey are required",
    );
  }

  const typedUserId = userId as number;
  const typedSlotId = slotId as number;
  const typedKey = idempotencyKey.trim();

  // ── 2. Idempotency check: Trả về booking cũ nếu key đã tồn tại ───────────
  // Thực hiện TRƯỚC transaction để tránh vòng lặp lock khi retry.
  const existingBooking = await db
    .selectFrom("bookings")
    .selectAll()
    .where("idempotency_key", "=", typedKey)
    .executeTakeFirst();

  if (existingBooking) {
    // Request được retry với cùng idempotency key → trả lại kết quả cũ.
    return Response.json(serializeBooking(existingBooking), { status: 201 });
  }

  // ── 3. Kiểm tra user và slot tồn tại ─────────────────────────────────────
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", typedUserId)
    .executeTakeFirst();

  if (!user) {
    return jsonError(404, "USER_NOT_FOUND", "User was not found");
  }

  const slot = await db
    .selectFrom("slots")
    .select(["id", "remaining"])
    .where("id", "=", typedSlotId)
    .executeTakeFirst();

  if (!slot) {
    return jsonError(404, "SLOT_NOT_FOUND", "Slot was not found");
  }

  // ── 4. Thực thi trong Transaction để đảm bảo tính nhất quán ──────────────
  // Toàn bộ logic đặt chỗ nằm trong một transaction:
  //   - INSERT booking
  //   - UPDATE slot.remaining (với điều kiện remaining > 0 — atomic check)
  // Nếu bất kỳ bước nào thất bại, toàn bộ transaction sẽ bị rollback.
  try {
    const booking = await db.transaction().execute(async (trx) => {
      // Bước 4a: Giảm remaining ngay lập tức với WHERE remaining > 0.
      // Đây là kỹ thuật "optimistic locking" — nếu không có hàng nào được update
      // (tức remaining đã = 0 do request khác đến trước), numUpdatedRows sẽ = 0.
      const updateResult = await trx
        .updateTable("slots")
        .set(({ eb }) => ({
          remaining: eb("remaining", "-", 1),
        }))
        .where("id", "=", typedSlotId)
        .where("remaining", ">", 0) // ← Điều kiện quan trọng chống race condition
        .executeTakeFirst();

      if (updateResult.numUpdatedRows === BigInt(0)) {
        // Không có hàng nào được update → slot đã hết chỗ (do request đồng thời)
        return null;
      }

      // Bước 4b: Tạo booking record sau khi đã chắc chắn trừ được remaining.
      return await trx
        .insertInto("bookings")
        .values({
          user_id: typedUserId,
          slot_id: typedSlotId,
          idempotency_key: typedKey,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    // Null có nghĩa là UPDATE không tác động được hàng nào → slot full
    if (booking === null) {
      return jsonError(409, "SLOT_FULL", "Slot is fully booked");
    }

    return Response.json(serializeBooking(booking), { status: 201 });
  } catch (error) {
    // ── 5. Xử lý các lỗi constraint từ DB ────────────────────────────────────
    if (isUniqueConstraintError(error)) {
      const message = (error as Error).message;

      // 5a. Trường hợp trùng idempotency_key (race condition: 2 request
      //     cùng đi qua bước check ở bước 2 đồng thời trước khi có bản ghi)
      if (message.includes("bookings.idempotency_key")) {
        const retryBooking = await db
          .selectFrom("bookings")
          .selectAll()
          .where("idempotency_key", "=", typedKey)
          .executeTakeFirst();

        if (retryBooking) {
          return Response.json(serializeBooking(retryBooking), { status: 201 });
        }
      }

      // 5b. Trường hợp cùng user đã đặt cùng slot này rồi
      if (message.includes("bookings_user_slot_unique")) {
        return jsonError(
          409,
          "ALREADY_BOOKED",
          "This user has already booked this slot",
        );
      }
    }

    return jsonError(500, "INTERNAL_ERROR", "Unexpected booking error");
  }
}

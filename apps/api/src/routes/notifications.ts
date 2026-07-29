import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, privacyReacceptanceGate, tosReacceptanceGate, type AuthedRequest } from "../auth.js";

export const notificationsRouter = Router();
notificationsRouter.use(authMiddleware);
notificationsRouter.use(privacyReacceptanceGate);
notificationsRouter.use(tosReacceptanceGate);

// Cursor pagination, mirroring the exact convention already established for
// GET /importers/:id/events (base64 "<created_at ISO>|<id>" keyset — see the
// comment on that endpoint for the full rationale). Not shared as a common
// utility with that endpoint: doing so would mean editing an unrelated,
// already-working route in importers.ts, which is out of this issue's scope
// (see implementation.md).
function decodeNotificationsCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep === -1) return null;
    return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function encodeNotificationsCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64");
}

const NotificationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// GET /notifications — paginated, for the authenticated user, most recent first.
notificationsRouter.get("/", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = NotificationsQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: "invalid query", details: parse.error.issues });
    return;
  }
  const { limit } = parse.data;

  let cursor: { createdAt: string; id: string } | null = null;
  if (parse.data.cursor) {
    cursor = decodeNotificationsCursor(parse.data.cursor);
    if (!cursor) {
      res.status(400).json({ error: "invalid cursor" });
      return;
    }
  }

  // Lists ALL of the user's notifications (read and unread), so this query
  // doesn't match idx_notifications_user_unread's partial WHERE read_at IS
  // NULL predicate — that index is shaped for the unread-count endpoint
  // below, not this one. At one user's realistic notification volume this
  // is a cheap sequential scan + sort either way; not adding a second index
  // beyond the one the issue's DDL specifies.
  const rows = cursor
    ? await pool.query(
        `SELECT id, kind, message, read_at, created_at FROM notifications
         WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [user.id, cursor.createdAt, cursor.id, limit],
      )
    : await pool.query(
        `SELECT id, kind, message, read_at, created_at FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [user.id, limit],
      );

  const notifications = rows.rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    message: n.message,
    readAt: n.read_at,
    createdAt: n.created_at,
  }));

  const last = rows.rows[rows.rows.length - 1];
  const nextCursor =
    rows.rows.length === limit && last ? encodeNotificationsCursor(last.created_at, last.id) : null;

  res.json({ notifications, nextCursor });
});

// GET /notifications/unread-count — count of this user's unread notifications.
notificationsRouter.get("/unread-count", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const r = await pool.query(
    "SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [user.id],
  );

  res.json({ unreadCount: Number(r.rows[0]!.count) });
});

// PATCH /notifications/:id/read — mark one notification read (owner or surety_admin).
notificationsRouter.patch("/:id/read", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const notificationId = String(req.params.id ?? "");

  // read_at is only ever set once, on first read (COALESCE), so a repeat
  // PATCH is a safe no-op that preserves the original read timestamp rather
  // than resetting it.
  const r =
    user.role === "surety_admin"
      ? await pool.query(
          `UPDATE notifications SET read_at = COALESCE(read_at, now())
           WHERE id = $1
           RETURNING id, kind, message, read_at, created_at`,
          [notificationId],
        )
      : await pool.query(
          `UPDATE notifications SET read_at = COALESCE(read_at, now())
           WHERE id = $1 AND user_id = $2
           RETURNING id, kind, message, read_at, created_at`,
          [notificationId, user.id],
        );

  const notification = r.rows[0];
  if (!notification) {
    // Generic 404 whether the row doesn't exist or belongs to someone else —
    // matches loadImporterFor's convention elsewhere in this codebase of not
    // distinguishing "not found" from "not yours" in the response.
    res.status(404).json({ error: "not found" });
    return;
  }

  res.json({
    notification: {
      id: notification.id,
      kind: notification.kind,
      message: notification.message,
      readAt: notification.read_at,
      createdAt: notification.created_at,
    },
  });
});

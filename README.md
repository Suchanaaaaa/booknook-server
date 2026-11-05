# BookNook API Server

Express + MongoDB API for the BookNook Next.js client.

## API routes
- `GET /books` — public list, newest first; optional `?limit=6`. Use `?mine=1` with a valid JWT to retrieve only the signed-in user's books.
- `GET /books/:id` — book details.
- `POST /books` — JWT-protected book creation.
- `PATCH /books/:id` — JWT-protected owner-only update.
- `DELETE /books/:id` — JWT-protected owner-only delete (blocked while active borrows exist).
- `POST /borrows` — JWT-protected borrow; prevents duplicate active borrows and decrements copies atomically.
- `GET /borrows` — JWT-protected current user's active borrows.
- `DELETE /borrows/:id` — JWT-protected return; restores one available copy.

## Run locally
1. Copy `.env.example` to `.env` and configure MongoDB and `API_JWT_SECRET`.
2. Ensure `API_JWT_SECRET` exactly matches the value in the client `.env.local`.
3. Run `npm install` then `npm run dev`.

MongoDB transactions require a replica set. MongoDB Atlas provides this by default; a standalone local MongoDB server must be configured as a replica set for the borrow/return transaction workflow.

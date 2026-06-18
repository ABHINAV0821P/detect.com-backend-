# Detect Backend

Express API for the Detect incident reconstruction app.

## Local development

1. Copy `.env.example` to `.env` and fill in the values.
2. Install dependencies with `npm install`.
3. Run `npm run dev`.

The API runs on `http://localhost:4000`.

## Vercel deployment

1. Import this repository into Vercel.
2. Set the project root to `/`.
3. Add the same environment variables from `.env.example`.
4. Set `CORS_ORIGIN` to include your frontend Vercel URL.

The backend uses `api/index.js` as the Vercel serverless entrypoint.

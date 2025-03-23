# Futures AI Trading Backend

## Setup
1. Clone the repository: `git clone <backend-repo-url>`
2. Navigate to the directory: `cd futures-ai-trading-backend`
3. Install dependencies: `npm install`
4. Deploy to Vercel (see below).

## Deployment on Vercel
1. Go to [vercel.com](https://vercel.com) and sign in.
2. Click "New Project" > Import Git Repository > Choose `futures-ai-trading-backend`.
3. Set environment variables: Add `POLYGON_API_KEY` with your key.
4. Deploy the site. Note the URL (e.g., `https://trading-platform-backend-vert.vercel.app`).

## Notes
- Replace `YOUR_POLYGON_API_KEY` in `api/index.js` with your Polygon API key.
- Ensure the `vercel.json` file is included to handle CORS headers.

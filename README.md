# Carfax Bundle Server

This server creates one customer link for multiple vehicle report links.

## Local test

```powershell
node server.js
```

Customer demo:

```text
http://127.0.0.1:3000/r/demo5
```

Admin:

```text
http://127.0.0.1:3000/admin
```

## Environment variables

```text
ADMIN_PASSWORD=your-private-admin-password
DATA_DIR=/path/to/persistent/data
PORT=3000
```

`ADMIN_PASSWORD` protects `/admin` and the bundle creation API.

`DATA_DIR` should point to persistent storage in production. If the host rebuilds or restarts without persistent storage, JSON data can be lost.

## Deploy To Render

1. Create a new GitHub repository with these files.
2. In Render, create a new Web Service from that repository.
3. Build command: leave empty or use `npm install`.
4. Start command: `npm start`.
5. Add environment variable `ADMIN_PASSWORD`.
6. Add persistent disk and set `DATA_DIR` to that disk path.
7. Render will provide a public `onrender.com` URL.
8. Add your custom domain in Render, then follow Render's DNS instructions.

Render supports Node.js web services and custom domains.

## Deploy To Railway

1. Create a new GitHub repository with these files.
2. In Railway, deploy from the repository.
3. Railway detects the Node.js app from `package.json`.
4. Add environment variable `ADMIN_PASSWORD`.
5. Add persistent storage or use a database before real sales.
6. Generate a Railway public domain, then add your own custom domain if desired.

Railway supports public domains and environment variables for Node apps.

## Creating Customer Links

Open:

```text
https://yourdomain.com/admin?password=YOUR_PASSWORD
```

Paste one report link per line and click **Create bundle**.

The customer receives one link:

```text
https://yourdomain.com/r/GENERATED_TOKEN
```

## Production Notes

- Use a fixed domain before sending links to paying customers.
- Keep `ADMIN_PASSWORD` private.
- Use persistent storage or a real database.
- Back up customer bundle data regularly.
- Keep raw report links hidden until the customer opens a report.

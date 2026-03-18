# ☁️ CloudShare — File Sharing App

Upload any file, get a shareable link. Set expiry time, password, and download limits.

---

## HOW TO RUN

### Step 1 — Install Node.js
Download from: https://nodejs.org (v16 or higher)

### Step 2 — Install PostgreSQL
Download from: https://www.postgresql.org/download

### Step 3 — Create the database
Open your terminal and run:
```
psql -U postgres
CREATE DATABASE cloudshare;
\q
```
Then run the schema:
```
psql -U postgres -d cloudshare -f schema.sql
```

### Step 4 — Set your database password in server.js
Open server.js, find this section (around line 20):
```
const pool = new Pool({
  host: 'localhost',
  database: 'cloudshare',
  user: 'postgres',
  password: 'password',   <-- change this to your PostgreSQL password
});
```

### Step 5 — Install dependencies
```
npm install
```

### Step 6 — Start the server
```
node server.js
```

### Step 7 — Open in browser
```
http://localhost:3000
```

---

## FILES IN THIS PROJECT

```
CloudShare/
├── server.js          ← Backend (Node.js + Express)
├── package.json       ← Dependencies list
├── schema.sql         ← Database tables setup
├── uploads/           ← Uploaded files go here (auto-created)
└── public/
    ├── index.html     ← Landing page
    ├── login.html     ← Login page
    ├── signup.html    ← Sign up page
    ├── dashboard.html ← Main dashboard
    ├── style.css      ← All styles
    ├── script.js      ← Frontend logic
    └── 404.html       ← Error page
```

---
## Login Page
![Login](screenshots/login.png)

## Dashboard
![Dashboard](screenshots/dashboard.png)


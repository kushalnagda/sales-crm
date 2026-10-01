# Sales CRM

A multi-user client CRM for a wealth / investment sales team (PMS, AIF, MF), built around the team's existing Excel sheet.

- **Website:** plain HTML/JS, hosted free on GitHub Pages
- **Database and logins:** [Supabase](https://supabase.com) (free tier)

## Features

**Everyone**
- **My dashboard:** clients, Hot, Converted, overdue follow-ups, due today, connects today and over 7 days, and clients not contacted for 30+ days.
- **Clients:** the same fields as the team sheet (Client_Name, Location, Email id, Contact, Remark, Status, PMS/AIF/MF, Last connected, Next_Action, Next Connect, Products pitched). **Day Since Contacted** and **Follow ups (OVERDUE / TODAY / UPCOMING)** are calculated automatically.
- **Log a connect:** record a call, meeting, WhatsApp, email or note. This sets "Last connected" to today and can set the next connect date. The full history is kept per client.
- **Follow-ups:** lists of overdue, today, next 7 days, and clients with no date set.
- **Bulk upload:** upload the team's Excel sheet (.xlsx/.xls/.csv) as it is. Columns are detected automatically, you get a preview before importing, and duplicate contact numbers are skipped. A template download is included.
- **Export to Excel** in the same column layout as the team sheet.

**Admin only**
- **Admin dashboard:** company-wide KPIs plus a **team performance table** (clients, Hot/Warm/Cold, converted, overdue, connects today and over 7 days, last activity, per person).
- **Team & users:** create employee or admin logins, change roles, and deactivate or reactivate users.
- See **all clients**, filter by team member, and **bulk assign** or **bulk delete**.
- During bulk upload, choose who the clients are assigned to, or include an "Assigned To" column (with a name or email).

**Security:** employees only ever see the clients assigned to them. This is enforced by the database (Row Level Security in `supabase/setup.sql`), not only hidden in the screen.

## Try it first (demo mode)

While `config.js` still has the placeholder values, the app runs in **demo mode**: data is stored only in your browser. Open `index.html` and sign in with:
- Admin: `admin@demo.com` / `admin123`
- Employee: `employee@demo.com` / `emp123`

## Go live for your team (about 15 minutes, one time)

### 1. Create the database
1. Sign up at https://supabase.com and click **New project**. Choose the **Mumbai (ap-south-1)** region and set a database password.
2. Open **SQL Editor → New query**. Paste in all of `supabase/setup.sql`.
3. **Near the bottom of the script, replace `YOUR_EMAIL@example.com` and `Your Name` with your own details**, then click **Run**.

### 2. Settings in Supabase
1. **Authentication → Sign In / Providers → Email:** turn **OFF "Confirm email"**. Leave "Allow new users to sign up" **ON**.
   Only emails that an admin has added can create an account, because the database blocks every other email.
2. **Authentication → Users → Add user → Create new user:** enter your email and a password, and tick **Auto Confirm User**. This is your admin login.

### 3. Connect the website
1. Go to **Project Settings → API** (or **Data API**) and copy the **Project URL** and the **anon public** key.
2. Paste both into `config.js`. You can also change `COMPANY_NAME` there.

   The anon key is meant to be public. Never put the `service_role` key in this file.

### 4. Put it on GitHub
1. Go to https://github.com/new and create a repository named `sales-crm`.
2. Click **"uploading an existing file"** and drag in everything inside this folder, including the `supabase` folder. Then click **Commit**.
3. Go to **Settings → Pages → Deploy from a branch → `main` / root → Save**. After about a minute, the app is live at `https://<your-username>.github.io/sales-crm/`.

   GitHub Pages on a **private** repository needs a paid GitHub plan. A public repository is safe, because the code contains no client data and no secrets. All data stays in Supabase behind logins.

### 5. Add your team
Sign in, go to **Team & users**, and create a login for each employee. Share their email and temporary password with them, and they can change the password under **My account**.
Then use **Bulk upload** to import your existing Excel sheet, and assign the clients to each person.

## Notes
- **Backups:** Supabase's free plan doesn't include automatic backups you can download. Use **Export to Excel** regularly as your own backup.
- Free Supabase projects **pause after 7 days with no activity**. Daily use keeps the project active, and a paused project can be resumed from the Supabase dashboard.
- Excel import and export load a small library from the internet the first time you use them.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Styling (light and dark) |
| `config.js` | Your Supabase URL and anon key |
| `api.js` | Data layer (Supabase or demo) |
| `app.js` | All screens and logic |
| `supabase/setup.sql` | Database tables, security rules, first admin |

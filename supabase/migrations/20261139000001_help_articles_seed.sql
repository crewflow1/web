-- Seed the starter help / knowledge-base articles for the core workflows.
--
-- Global platform content (see 20261139000000_help_articles.sql). Idempotent:
-- fixed UUIDs + `on conflict (slug) do nothing`, so re-running never duplicates
-- rows or clobbers later edits (an operator/HQ edit to an article wins over a
-- re-applied seed). Slugs are STABLE — the contextual HelpLink components in the
-- app deep-link to these exact slugs (creating-a-quote, converting-a-quote-to-a-
-- job, sending-your-first-invoice, inviting-your-team), so do not rename them
-- without updating those links.

insert into public.help_articles
  (id, slug, category, title, summary, keywords, sort_order, body)
values
  (
    '11111111-0000-4000-a000-000000000001',
    'getting-started',
    'getting-started',
    'Getting started with CrewFlow',
    'A five-minute tour of the workspace and the first things worth setting up.',
    array['setup','onboarding','tour','first steps','welcome','basics'],
    10,
    $md$
# Welcome to CrewFlow

CrewFlow runs the office side of your trade business — quoting, jobs, invoicing, and the paperwork in between — in one place. This guide points you at the first few things worth doing.

## The layout

The left sidebar is your main menu. The pages you will use most are near the top:

- **Dashboard** — the day's headline numbers and what needs you.
- **Leads** and **Quotes** — work you are chasing and pricing.
- **Jobs** — work you have won and are delivering.
- **Invoices** and **Payments** — getting paid.

## Set up first

1. Open **Settings** and check your organisation name, address, and logo — these appear on quotes and invoices your customers see.
2. Add a customer under **Customers** (or create one on the fly from a quote).
3. Invite the rest of your team so they can log their own work — see *Inviting your team*.

## The usual flow

Most work moves through the same path: a **lead** becomes a **quote**, an accepted quote becomes a **job**, and a completed job becomes an **invoice**. Each step carries the details forward so you are never re-typing.

Stuck at any point? Look for the **?** next to a page title, or raise a ticket from **Support**.
$md$
  ),
  (
    '11111111-0000-4000-a000-000000000002',
    'creating-a-quote',
    'quotes',
    'Creating a quote',
    'Build a priced quote, add line items, and send it to your customer for approval.',
    array['quote','estimate','pricing','line items','proposal','send quote'],
    10,
    $md$
# Creating a quote

A quote is a priced proposal you send a customer. When they accept it, you can turn it straight into a job.

## Build the quote

1. Go to **Quotes** and choose **+ New quote**.
2. Pick the **customer** (or add a new one).
3. Add **line items** — a description, quantity, and unit price for each. The total updates as you go.
4. Add any notes or terms the customer should see.

## Send it

Save the quote, then use **Send** to email it to the customer. They get a link where they can review and **accept** it online — no login required.

## After it is accepted

An accepted quote can be **converted to a job** in one step, carrying the line items and customer across. See *Converting a quote to a job*.

> Tip: duplicate a similar past quote to save re-typing common line items.
$md$
  ),
  (
    '11111111-0000-4000-a000-000000000003',
    'converting-a-quote-to-a-job',
    'jobs',
    'Converting a quote to a job',
    'Turn an accepted quote into a scheduled job without re-entering the details.',
    array['job','convert','won work','schedule','accepted quote','create job'],
    10,
    $md$
# Converting a quote to a job

Once a customer accepts a quote, the work becomes a **job** — the thing your team delivers and logs against.

## Convert in one step

1. Open the accepted quote under **Quotes**.
2. Choose **Convert to job**.
3. The customer and priced line items carry across automatically. Set a **start date** and assign the team.

## Running the job

From the job you can:

- Schedule it and assign staff.
- Log site diary entries, photos, and snags against it.
- Track materials and costs.

## When the work is done

A completed job can be **invoiced** directly, so what you quoted flows through to what you bill. See *Sending your first invoice*.
$md$
  ),
  (
    '11111111-0000-4000-a000-000000000004',
    'sending-your-first-invoice',
    'invoicing',
    'Sending your first invoice',
    'Raise an invoice from a job, send it, and track when it is paid.',
    array['invoice','billing','get paid','payment','vat','send invoice'],
    10,
    $md$
# Sending your first invoice

An invoice is your formal request for payment. The quickest route is straight from a completed job.

## Raise the invoice

1. Go to **Invoices** and choose **+ New invoice** — or open a finished job and invoice it directly, which pulls the line items across.
2. Check the customer, line items, and any **VAT**.
3. Set the **due date** and payment terms.

## Send and get paid

Use **Send** to email the invoice with a payment link. As money comes in, record it under **Payments** (or it reconciles automatically if online payments are enabled) — the invoice status moves to **paid**.

## Keeping on top of it

The **Cash position** page shows who still owes you and your overall money-in / money-out picture, so nothing slips through.
$md$
  ),
  (
    '11111111-0000-4000-a000-000000000005',
    'inviting-your-team',
    'team',
    'Inviting your team',
    'Add your crew so they can log their own jobs, hours, and site records.',
    array['team','invite','staff','members','users','roles','permissions'],
    10,
    $md$
# Inviting your team

Adding your crew means they log their own work — you are not re-typing site records at the end of the day.

## Send an invite

1. Open **Settings** and find the **Members** section.
2. Enter the person's email and send the invite.
3. They get an email link to set a password and join your workspace.

## Roles

- **Owners / admins** see the full business — money, quotes, invoices, and settings.
- **Staff** see a slimmer view built around their day — their jobs, site diary, toolbox talks, and leave.

Give office staff admin access and field crew the staff role. You can invite as many people as your plan allows.

## What staff can do

Staff log jobs, snags, site diary entries, toolbox talks, and their own leave — the records that used to live on paper or in a group chat.
$md$
  ),
  (
    '11111111-0000-4000-a000-000000000006',
    'the-customer-portal',
    'portal',
    'The customer portal',
    'How customers view quotes, approve work, and see invoices through their own portal.',
    array['portal','customer','client','approve','accept','share','link'],
    10,
    $md$
# The customer portal

When you send a quote or invoice, your customer gets a secure link to their own **portal** — no account or password needed.

## What customers can do

- **Review and accept quotes** online. An acceptance is recorded against the quote so you have a clear audit trail.
- **View invoices** and, where online payments are enabled, pay them directly.
- **Message you** about the work, which lands back in your Support area.

## How it stays secure

Each link is tied to that customer and that document. Customers only ever see their own quotes and invoices — never anyone else's, and never your internal notes.

## Sharing a link

Every quote and invoice has a **Send** action that emails the portal link. You can re-send at any time if a customer misplaces it.
$md$
  )
on conflict (slug) do nothing;

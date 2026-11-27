# Sloppanizer as a product: organizations, licenses, legal baseline

Written 2026-11-27 from the code at v1.2.2, the decisions log, and research into Swiss, EU, UK and US rules
and into billing providers. A plan, not a decision record: the open choices are listed at the end. Every
step is designed so that the people using Sloppanizer today notice nothing until a feature is switched on
for them, and are never forced to move anything.

## 1. Where we start

What exists (file references are in the repo):

- One hosted instance: API in Docker on a VPS (`deploy/compose.yaml`, Caddy, Watchtower, one SQLite file in
  the `/data` volume), web app on Vercel at organizer.omeldar.com, API at organizerapi.omeldar.cloud.
- Accounts are either people (`kind = user`) or hidden "space" accounts that hold a shared project's data
  (`apps/server/src/db/auth-schema.ts`). Every data row carries `account_id`; ids are numbered per account.
  Shared projects are entered with the `X-Sloppanizer-Space` header, membership is checked per request.
  This is already a sound tenant-isolation primitive and the plan keeps it.
- Sign-in moves to auth.omeldar.com (OIDC). New accounts need an admin's approval. Roles are `user` and
  `admin` per instance. 2FA is mandatory. No cookies, no email sending of any kind, no password reset by mail.
- Export (zip, format 9) and restore per account exist. Instance backups exist but stay on the same server.
- No billing, plans, seats, feature flags, legal pages, localization, release notes UI, or retention of done
  todos. Attachments are never deleted. Account deletion is immediate and does not clean orphaned spaces.
- The repo is public but `UNLICENSED`, and the README still describes the old single-user install
  (`ORGANIZER_*` variables, `deploy/install.sh`, `org_` tokens, export format 3).

What has to be true at the end: a person has a free personal workspace; a person can create an organization;
an organization has members, teams, projects, policies and a subscription; existing shared projects can be
moved under a team with their ids and links intact; the legal documents, retention rules and deletion
behavior meet Swiss law and are good enough for EU, UK and US business customers.

## 2. Target model

### Entities

```
person (accounts, kind=user)          one identity at auth.omeldar.com, many organizations
  └─ personal workspace                todos, notes, people, meetings, planner (free, stays as is)
  └─ personal shared projects          today's spaces with no organization (stay free, grandfathered)

organization                           the tenant that buys licenses
  ├─ organization_members              role: owner | admin | billing | member
  ├─ organization_invitations          by email, token, expiry; accepting = joining (and taking a seat)
  ├─ teams                             groups inside the organization (optional; "Everyone" team by default)
  │    └─ team_members
  ├─ projects                          today's spaces with team_id set (team or organization-wide)
  ├─ organization_policies             retention, AI, who may create projects, allowed email domains
  ├─ subscription                      Stripe customer id, subscription id, seat count, status, plan
  └─ organization_audit                who changed members, policies, billing, projects (metadata only)
```

Principles behind it:

- **Organizations live in Sloppanizer, not in auth.omeldar.com.** Auth stays the identity provider for all
  omeldar apps (who you are, 2FA, passkeys). Membership, roles, billing and policies are product data.
  Later, per-organization SSO (a customer's Entra/Google/Okta) is added at auth as extra identity providers
  and mapped to an organization by email domain; nothing in Sloppanizer changes for that.
- **A project is still a space account.** `spaces` gets `organization_id` and `team_id` (nullable). A
  personal shared project has both null. Moving a project into a team is an UPDATE of two columns, so
  todo numbers (`S7#12`), links, tokens, MCP connections, files and history all stay.
- **Access to a project** = member of the project (as today) or, when the project belongs to a team, member
  of that team; organization admins can see every project of the organization in the admin view and add
  themselves. Today's `space_members` table stays as the explicit list; team membership is a second path
  checked in `enterSpace` (`http/security.ts`).
- **A seat is an active organization member.** Invitations that are not accepted are not seats. The seat
  count is synced to Stripe when a member joins or is removed; Stripe prorates.
- **Personal data stays personal.** Meetings, planner, people, notes outside projects, AI settings and
  tokens remain per person; organizations never see them. Only project data (todos, comments, files, notes
  in the project) belongs to the organization, which matters for who is controller and processor (section 5).

### URLs

Today: `/u/<username>/…` and `/u/<username>/shared/<spaceId>/…`. Keep both forever. Add
`/o/<org-slug>/…` for the organization's own pages (members, teams, policies, billing, audit) and
`/o/<org-slug>/p/<spaceId>/…` as the canonical address of an organization project. Old shared-project links
redirect to the new address once a project is moved.

## 3. Rollout principles (the "smooth transition" rules)

1. **Feature flags before features.** Add a small flag mechanism: instance-wide flags in `instance_settings`,
   plus per-account and per-organization overrides in a `feature_flags` table. Routes answer 404 and the web
   app hides the entry point while a flag is off, so a half-built feature can ship in any release. The
   existing `SLOPPANIZER_AUTH=local|both|oidc` switch is the model: every big change has an off position.
2. **Additive migrations only.** New tables and nullable columns. Nothing is renamed or dropped until a release
   or two after the feature is on. Drizzle runs migrations in one transaction with foreign keys on
   (`docs/DECISIONS.md`, 2026-11-18), so no table rebuilds in this program.
3. **Nothing moves by itself.** Personal data and personal shared projects stay exactly where they are. The
   person (or a project owner) moves a project into an organization; the organization never pulls.
4. **Grandfathering.** Everything a person can do today stays free for them: personal workspace, personal
   shared projects with any number of members, MCP, API, export. Paid is only what is new: organizations.
   Document this once in the pricing page ("Personal: free, forever").
5. **Announce in the app, once, with a date.** Reuse the update banner pattern: a dismissible line under the
   top bar plus a "What's new" page fed from `CHANGELOG.md`. Legal documents get a 30-day notice before they
   take effect.
6. **One switch to roll back.** Each phase ends with its flag on for one pilot organization (the team at
   work) before it is on for everyone.

## 4. Phases

Effort is for one developer working with Claude, in calendar weeks, assuming the current pace of releases.

### Phase 0: groundwork (about 2 weeks)

Business side, in parallel with the code:

- **Written consent from the employer** that the side business is permitted, that the code was created
  outside working time and duties (Art. 321a and 332 OR, Art. 17 URG), and that the team's use is governed by
  an ordinary customer agreement. Do this before any colleague pays anything. It is the single largest risk
  in the whole plan.
- **Start as an Einzelfirma** (sole proprietorship): exists as soon as you trade, gets a UID, no capital, no
  notary. Register in the Handelsregister voluntarily (about CHF 120 federal fee plus cantonal) because Stripe
  onboarding, invoices and the imprint look better with it, and it is mandatory at CHF 100k turnover anyway.
  Register with the cantonal Ausgleichskasse as nebenberuflich selbständig once net side income passes
  CHF 2,500 a year. Move to a GmbH (CHF 20k capital, about CHF 1–4k founding cost) when revenue or liability
  justifies it; the Stripe account and contracts transfer, so nothing in the product depends on this.
- **Pick the license for the public repo.** Today "UNLICENSED" means all rights reserved; the public can read
  but not self-host, which is fine for a hosted business but should be explicit. Recommendation: FSL-1.1-MIT
  (Sentry's Functional Source License): anyone may use and self-host, nobody may sell a competing hosted
  service, each release becomes MIT after two years. Add a short trademark note (the name Sloppanizer) and a
  CLA or DCO for contributors. Alternative: stay closed and say so in a LICENSE file.
- **Pick the product domain** now, because the web origin is baked into CSP, CORS, OIDC redirect URIs and the
  passkey RP id (`SLOPPANIZER_RP_ID`). Changing it later is a migration of its own. Either keep
  organizer.omeldar.com or move once, with redirects, before anyone pays.
- **Confirm the VPS provider and location** (needed for the sub-processor list and the "countries" line of
  the Swiss privacy notice). Hosting in Switzerland or the EU avoids a transfer question for the main data.

Code side:

- Feature flag mechanism (above).
- **Off-site encrypted backups.** Instance backups currently stay on the VPS. Ship the nightly zip to object
  storage in CH/EU (Hetzner, Infomaniak, Exoscale) with `SLOPPANIZER_DATA_KEY`-independent encryption, keep 30
  days, test a restore once a quarter. Consider Litestream for continuous SQLite replication. Paying customers
  will ask, and the retention policy has to state a backup lifetime.
- **Log retention.** Caddy access logs and `sessions.ip`/`user_agent` are personal data: rotate logs at 30
  days, document it. Already fine: sessions are pruned 30 days after revocation (`services/jobs.ts`).
- **Transactional email.** Organizations need invitations, billing notices and breach notices by email.
  Choose a provider in CH/EU (Infomaniak, Mailjet, Brevo) or Postmark; it becomes a sub-processor. Auth keeps
  handling sign-up mail if it does; Sloppanizer sends only its own.
- **README and docs cleanup** so the public repo describes the product as it is (hosted, OIDC, `spz_`
  tokens, export format 9, `SLOPPANIZER_*` variables).
- Record the decisions in `docs/DECISIONS.md` as they are made.

### Phase 1: legal and privacy baseline, shipped dark (about 3 weeks)

- **Legal pages** in the web app and on the landing page: `/legal/terms`, `/legal/privacy`,
  `/legal/dpa`, `/legal/subprocessors`, `/legal/imprint`, `/legal/security`, `/legal/retention` (the
  retention schedule, see section 6). Markdown in the repo, versioned, each with an "effective from" date.
  Behind the `legal_pages` flag until the texts are reviewed.
- **Acceptance tracking.** `legal_acceptances(account_id, document, version, accepted_at, ip)`; organizations
  record the owner's acceptance of ToS and DPA at creation. Existing people get a banner 30 days before the
  terms take effect and an explicit accept on the next sign-in after that date (non-blocking before, one
  click after).
- **Imprint** (UWG Art. 3 para. 1 lit. s): first and last name or company name, address, email, UID; link in
  the landing footer and the app's Settings.
- **Retention features for people** (the privacy-by-design piece):
  - Settings, Privacy: "Delete done todos after: never / 30 / 90 / 180 / 365 days" (default for existing
    accounts: never, so nothing disappears; default for new accounts: 365 days). An hourly job deletes done
    todos older than the setting, with their comments, events, links and planner history, per account.
  - Attachment cleanup: files not referenced by any todo, note or comment of the account for 30 days are
    deleted (needs a reference scan like `services/move-todo.ts` already does, and a DELETE route).
  - "Delete my account" gets a 30-day grace: sessions and tokens revoked at once, a sign-in within 30 days
    cancels, the purge job deletes everything after. Self-deletion also removes orphaned spaces (today only
    the admin path does). Billing records are kept outside the account (section 6).
  - Export stays the portability answer (Art. 28 DSG, GDPR Art. 20, EU Data Act switching). Add JSON Lines
    for organization projects later.
- **Security page content** from what already exists: argon2id, mandatory 2FA, passkeys, encrypted AI keys,
  per-tenant isolation with composite foreign keys, CSP, no cookies, rate limits, daily backups, breach
  process (notify customers within 72 hours). Add a `security.txt`.
- **AI feature disclosure.** Label every AI suggestion as AI-generated (already "nothing is saved until you
  accept"), name Anthropic in the privacy policy and sub-processor list with SCCs as the transfer basis, and
  keep BYOK (the user's own key) as the default. This covers EU AI Act Art. 50 transparency (in force since
  2 Aug 2026) and Anthropic's own terms.
- Turn on at the end of the phase: legal pages, imprint, the retention setting, account deletion grace.

### Phase 2: organizations and teams, shipped dark (about 5 weeks)

Schema (all additive): `organizations`, `organization_members`, `organization_invitations`, `teams`,
`team_members`, `organization_policies`, `organization_audit`, `feature_flags`; `spaces.organization_id`,
`spaces.team_id`; `legal_acceptances.organization_id`.

Server:

- Create organization (name, slug, billing email; records ToS and DPA acceptance). The creator is owner.
- Members: invite by email (token link, 7-day expiry, re-send, revoke); accept while signed in at omeldar;
  roles owner / admin / billing / member; remove (unassigns the person's todos in every project of the
  organization, as leaving a project does today); transfer ownership; the last owner cannot leave.
- Teams: create, rename, archive, add and remove members. "Everyone" is implicit (organization-wide
  projects have `team_id` null).
- Projects: create a project inside a team (a space with the two columns set); **move an existing shared
  project into a team**: allowed when every current member is a member of the organization, otherwise the
  dialog invites the missing people first and completes when they have joined or are removed; undo is the
  same move back while the project has no organization-only data. Move a personal project into a team:
  built on `POST /todos/{id}/move` for each todo plus the project's notes, in one transaction, with the same
  "copy, close the original" semantics people already know.
- Policies (organization_policies, JSON with a schema in `packages/shared`):
  - `doneTodoRetentionDays`: applies to every project of the organization; members cannot keep done todos
    longer, the organization may allow shorter per project.
  - `closedProjectRetentionDays`: an archived project is deleted after N days (default: never).
  - `aiAllowed`: whether members may use the AI assistant on organization projects (and with which provider).
  - `whoMayCreateProjects`: admins | everyone.
  - `allowedEmailDomains`: only invite addresses from these domains (optional).
  - `externalMembersAllowed`: whether a project may keep members who are not in the organization (default
    no; this is what makes the seat count honest).
- Audit: every change of members, roles, teams, policies, billing and project ownership as metadata only,
  readable by owners and admins, exportable as CSV.
- Access check: `enterSpace` accepts a member of the project or a member of its team; organization admins
  can add themselves. Tokens and MCP keep working unchanged: `X-Sloppanizer-Space` stays the mechanism.
- API: `/api/v1/orgs`, `/orgs/{id}/members|invitations|teams|policies|audit|projects`; MCP adds
  `list_organizations` and shows the organization and team in `list_projects`. Browser session only for
  anything that changes members, policies or billing (same rule as shared projects today).

Web:

- Sidebar: "Shared" becomes "Shared with me" (personal shared projects) and one section per organization
  with its teams and projects. People in no organization see exactly what they see today.
- Organization pages under `/o/<slug>`: Overview, Members, Teams, Projects, Policies, Billing, Audit, Settings.
- "Move to organization" in the project's menu and in the share dialog, with the member check above.
- Instance admin page: list organizations, their plan and seat count, suspend, comp.

Turn on at the end of the phase for the pilot organization (the team at work, flag per organization).

### Phase 3: billing, shipped dark (about 3 weeks)

Provider: **Stripe** as payment service provider (you are the merchant), with Stripe Billing (per-seat
quantities, proration, Customer Portal), Stripe Checkout, Stripe Tax and Stripe Invoicing. Reasons: Swiss
sole proprietors are accepted; CHF plus TWINT (recurring TWINT since May 2026) and SEPA; Swiss UID and EU
VAT-ID validation; the invoice is yours, which B2B buyers want; no monthly fee. Lemon Squeezy is shutting down
(processing ends 31 March 2027), so it is out. Paddle (merchant of record, 5% + USD 0.50) is the fallback if
you decide to sell to consumers abroad and want zero tax administration; the product code should talk to a
small `billing` service module so that swapping providers touches one place.

Fees to expect: 2.9% + CHF 0.30 Swiss cards, 3.25% + CHF 0.30 international, 0.7% Billing, 0.5% Tax (only
where registered). Verify TWINT and Managed Payments availability in the Dashboard; figures from Stripe's
Swiss pricing page as of November 2026.

Plans (CHF, excluding VAT; mirror prices in EUR and USD with Stripe multi-currency):

| Plan | Who | Price | Includes |
| --- | --- | --- | --- |
| Personal | one person | free | everything today, personal shared projects, MCP, API, export |
| Team | organization | 9 per seat per month, or 90 per seat per year | teams, policies, invitations, audit, invoice billing from 10 seats annual |
| Business (later) | organization | about 16 per seat per month | SSO (customer IdP), SCIM, audit export/SIEM, data residency statement, SLA, priority support |

Comparable tools charge USD 8–12 per seat per month on annual billing (Todoist Business 8, Trello Premium 10,
Asana Starter 10.99, Linear Basic 10, Notion Plus 10, monday Standard about 12, as of November 2026), so 9 CHF
is in the band without being the cheapest. Minimum: none for monthly (a two-person team should be able to
pay), 14-day free trial without card, then read-only grace for 14 days after a failed payment.

Implementation:

- `organization_subscriptions(organization_id, stripe_customer_id, stripe_subscription_id, plan, seats,
  status, current_period_end, trial_ends_at)`; a `billing_events` table of processed webhook ids.
- Checkout creates the Stripe customer with the billing contact only (name, email, address, VAT/UID);
  seat users give nothing to Stripe. Webhooks (`checkout.session.completed`, `customer.subscription.*`,
  `invoice.*`) update the status; the seat count is pushed on every member change with proration.
- Entitlements are one function: `can(organization, feature)` from plan and status, used by routes and web.
  Trial and comped organizations (your pilot) are plan "team" with `status = comped`.
- Billing page: plan, seats, next invoice, "Manage in Stripe" (Customer Portal for cards, invoices,
  cancellation), VAT/UID field, invoice email.
- Taxes at launch: below CHF 100k worldwide turnover there is no Swiss VAT registration (consider voluntary
  registration to recover input VAT); EU and UK businesses are invoiced with reverse charge when they give a
  VAT ID; no US registrations. Stripe Tax monitors thresholds. Do not sell to consumers outside Switzerland
  at first (a VAT ID or a Swiss address is required at checkout), which avoids OSS, UK VAT and the EU 14-day
  withdrawal right until there is a reason to accept them.
- Records: Stripe keeps card data; you keep invoices and the billing contact for 10 years (Art. 958f OR,
  Art. 70 MWSTG) in Stripe plus an exported copy, outside the account tables, so account deletion never
  touches them.

Turn on at the end of the phase: new organizations get a trial, then Team; the pilot stays comped.

### Phase 4: open the doors (about 2 weeks)

- Public sign-up for personal accounts with email verification at auth (replace admin approval, keep a
  kill switch); organizations invite by email.
- Landing page: product, pricing, security, legal links, "Personal is free".
- Support: a support address, a documented response time, a status page (external, e.g. a hosted status
  service), the "What's new" page.
- Announce in the app: "Sloppanizer now has organizations. Nothing changes for your own todos. Move a shared
  project into your organization when you want to."
- First paying customer path: a two-page checklist for an IT or procurement contact (imprint, DPA,
  sub-processors, security page, export, deletion), which answers most SME questionnaires.

### Phase 5: business tier and scale (later, when a customer asks)

- Per-organization SSO through auth.omeldar.com (OIDC first, SAML when required), SCIM provisioning,
  audit log streaming, data residency statement, SLA with service credits, penetration test, then SOC 2
  Type I or ISO 27001 only when a deal depends on it (typically EUR 15–25k and 4–12 months).
- Scale: SQLite on one VPS carries this for a long time; when it does not, the per-account layout makes
  sharding by organization straightforward. Add Litestream earlier (Phase 0) so point-in-time recovery exists.
- EU and UK Article 27 representatives when EU or UK customers are actively marketed to (about EUR 300–1,500
  a year each); the DSA Article 13 legal representative question goes to counsel at the same time.

## 5. Legal: what is required and what we do about it

Who is who: for personal accounts you are the controller. For organization projects the customer is the
controller and you are the processor, which is why a DPA is part of the organization terms. Toward your
sub-processors (VPS, Vercel, Stripe, email, Anthropic) you need their DPAs and a list customers can see.

| Requirement | Source | What Sloppanizer does |
| --- | --- | --- |
| Privacy notice incl. recipient countries | Art. 19 DSG; GDPR Art. 13/14 | `/legal/privacy`, lists sub-processors with country and transfer basis (Swiss-US DPF for Stripe and Vercel, SCCs for Anthropic) |
| Imprint with email | UWG Art. 3(1)(s) | `/legal/imprint`, footer link everywhere |
| Processor contract, sub-processor authorisation | Art. 9 DSG; GDPR Art. 28 | `/legal/dpa` accepted at organization creation; `/legal/subprocessors` with 30-day notice of changes |
| Register of processing activities | Art. 12 DSG (SME exemption likely applies) | keep a one-page register anyway; customers ask |
| Breach notification | Art. 24 DSG; GDPR Art. 33 | runbook: assess, notify FDPIC when high risk, notify affected organizations within 72 h; `security.txt` |
| Access, portability, deletion | Art. 25/28/32 DSG; GDPR Art. 15/17/20 | account page shows all data; export zip; deletion with 30-day grace; 30-day response commitment |
| Privacy by design and default | Art. 7 DSG; GDPR Art. 25 | retention defaults for new accounts, BYOK AI, no analytics, no cookies |
| Cookies | ePrivacy Art. 5(3); FMG Art. 45c | none set (tokens in localStorage, strictly necessary); say so, no banner |
| Switching and exit | EU Data Act Art. 23–31 (applies since Sept 2025) | ToS: export any time, data retrievable 30 days after end, free switching; already met by the export |
| AI transparency | EU AI Act Art. 50 (since Aug 2026); Anthropic terms | AI suggestions labelled; Anthropic named; nothing saved without accept |
| Liability and termination | Art. 100/101/404 OR | cap at 12 months' fees, carve-outs for intent and gross negligence, monthly terms (so Art. 404 is moot), annual with pro-rata refund on your breach only |
| Consumer rules | UWG Art. 8; EU consumer law | not triggered while only businesses (VAT ID or Swiss address) can buy; personal plan is free |
| Bookkeeping records | Art. 958f OR; Art. 70 MWSTG | invoices and billing contact kept 10 years, separate from account data |
| Swiss VAT | Art. 10/11 MWSTG | not registered below CHF 100k worldwide turnover; Stripe Tax watches; optional voluntary registration |
| US state privacy laws | CCPA and others | thresholds far away; state "we do not sell or share personal information", honour requests globally |
| Representatives | GDPR/UK GDPR Art. 27; DSA Art. 13 | defer until EU/UK customers are actively targeted; ask counsel then |

Getting the documents: start from a reputable Swiss template set, have a Swiss IT lawyer review the set once
(ToS, DPA, privacy policy, imprint; expect CHF 1,500–4,000 at CHF 220–350 an hour), re-review when the
Business tier, representatives or the GmbH arrive. English as the binding language with Swiss law and a
Swiss forum; a German courtesy copy is nice for Swiss SMEs but not required.

## 6. Retention schedule (what the policy will say and what the code enforces)

| Data | Default | Who can change it | Mechanism |
| --- | --- | --- | --- |
| Done todos, personal | never (existing accounts), 365 days (new accounts) | the person | hourly job, Settings, Privacy |
| Done todos, organization projects | organization policy | organization admins set the maximum, members may shorten | hourly job |
| Attachments no longer referenced | deleted after 30 days | nobody | hourly job with reference scan |
| Archived organization projects | kept | organization policy | job |
| Notifications | newest 200 per person | nobody | exists |
| Sessions after revocation or expiry | 30 days | nobody | exists |
| Access logs, IPs | 30 days | nobody | log rotation |
| Account after deletion request | 30-day grace, then purge | the person can cancel by signing in | job |
| Organization after cancellation | read-only 30 days, then export reminder, then purge after 60 days | owner can request immediate purge | job |
| Backups | 30 days rotation, encrypted, off-site | nobody | backup job; deleted data expires with the backup |
| Billing records | 10 years | nobody (law) | Stripe plus exported copy |
| AI requests | nothing stored by Sloppanizer; Anthropic deletes within 30 days | the person (BYOK, can turn off) | existing |

## 7. Risks and how the plan handles them

- **Employer IP and loyalty claims.** Written consent before the first invoice; the colleagues' organization
  is a normal customer. Highest risk, cheapest fix.
- **Domain and passkey RP id.** Decide the domain in Phase 0; changing it later invalidates passkeys bound to
  the app's RP id and every OIDC redirect URI.
- **Single VPS, backups on the same disk.** Off-site backups and Litestream in Phase 0, before anyone pays.
- **Email becomes a dependency.** Pick a provider with a DPA and a CH/EU location; keep the app usable
  without email for personal accounts (invitations are the only hard dependency).
- **Seat leakage through external project members.** Policy default "no external members" and the move
  dialog's membership check.
- **Legal texts that nobody reads.** 30-day notice banner, one-click accept, versioned documents, and the
  acceptance table so you can prove it.
- **Lemon Squeezy-style provider risk.** Stripe directly, a thin billing module, no reseller in between.
- **Scope creep in "teams".** Teams are membership groups and nothing else in this program; no team-level
  settings, boards or statistics until someone asks.

## 8. Open decisions (yours)

1. Entity and timing: Einzelfirma now, GmbH later (recommended), or GmbH from the start.
2. Domain: keep organizer.omeldar.com or move once before Phase 3.
3. License for the public repo: FSL-1.1-MIT (recommended), AGPL with CLA, or stay closed with an explicit
   LICENSE file.
4. Billing provider: Stripe (recommended) or Paddle as merchant of record.
5. Price point and currency presentation: CHF 9 per seat per month and CHF 90 per year, with EUR and USD
   mirrors, or something else.
6. Whether personal shared projects stay free without a member limit (recommended for everyone who has one
   today; new ones could be capped at, say, 5 members to nudge teams toward organizations).
7. Email provider, VPS provider and location, backup storage provider.
8. Default retention for new personal accounts: 365 days (proposed) or never.

## 9. First concrete steps

1. Ask the employer for written consent; register the Einzelfirma and the UID.
2. Add the feature flag table and the off-site backup job; fix the README.
3. Write the first drafts of ToS, privacy policy, DPA, imprint and the retention schedule from this plan and
   send them for review.
4. Build Phase 1 behind flags; turn on legal pages and the retention setting with a 30-day notice.
5. Build Phase 2 behind flags; pilot with the team at work on a comped organization.
6. Open the Stripe account; build Phase 3; first paying organization.

/**
 * Static legal pages — GET /home, /privacy, /terms
 *
 * Google will not let the "REAL Solutions Lead Gen Monitor" OAuth app
 * (project real-solutions-lead-gen) leave Testing without an application
 * home page, a privacy policy URL and a terms of service URL. These are the
 * pages behind those three URLs.
 *
 * Google fetches them anonymously, so registerLegalRoutes() MUST be called
 * before the bearer-token guard in main.ts — same as the PAE and COMMS
 * routes. If it is registered after the guard these return 401 and the
 * verification fails.
 */

import type { Express, Request, Response } from 'express';

const EFFECTIVE_DATE = 'September 2, 2026';
const CONTACT = 'steven@real-solutions-llc.com';

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — REAL Solutions LLC</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 44rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a; background: #fff;
  }
  h1 { font-size: 1.75rem; margin: 0 0 .35rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  h3 { font-size: 1rem; margin: 1.25rem 0 .35rem; }
  .meta { color: #666; font-size: .9rem; margin: 0 0 2rem; }
  ul { padding-left: 1.25rem; }
  li { margin: .4rem 0; }
  a { color: #0b5cad; }
  nav { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid #e5e5e5; font-size: .9rem; }
  nav a { margin-right: 1.25rem; }
</style>
</head>
<body>
${body}
<nav>
  <a href="/home">Home</a>
  <a href="/privacy">Privacy Policy</a>
  <a href="/terms">Terms of Service</a>
</nav>
</body>
</html>`;
}

const HOME = layout('REAL Solutions', `
<h1>REAL Solutions LLC</h1>
<p class="meta">Software for commercial real estate work.</p>

<p>REAL Solutions LLC builds internal tools and applications used in commercial
real estate acquisition — deal intake, lead capture, and analysis.</p>

<h2>REAL Solutions Lead Gen Monitor</h2>
<p>An internal application that reads our own REAL Solutions business mailbox,
identifies commercial property listings and broker broadcast emails, and
captures the property details into our CRM so that no lead is missed.</p>
<p>It reads only our own mailbox. It does not read, collect, or store any third
party's mail, and it is not offered as a service that connects to other
people's inboxes.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
`);

const PRIVACY = layout('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="meta">REAL Solutions LLC &middot; Effective ${EFFECTIVE_DATE}</p>

<h2>Who we are</h2>
<p>REAL Solutions LLC ("REAL Solutions", "we") builds software for commercial
real estate work. This policy explains what we do and, just as importantly,
what we cannot do with data.</p>
<p>Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>

<h2>1. Software we release to others runs on your machine</h2>
<p>The applications and tools we build and release are locally hosted. They run
on your own computer, and the data you put into them stays there.</p>
<p>We have no access to that data. We cannot import it, export it, send it, or
receive it &mdash; the software has no capability to do any of those things.
Your data moves only if you move it yourself.</p>
<p>Because we never hold it, there is nothing for us to sell, share, or hand to
anyone else.</p>

<h2>2. One thing to know about browser-based tools</h2>
<p>Some of what we build is HTML &mdash; pages and apps that run in your web
browser. Browsers keep things. Information you enter may persist in your own
browser's local storage, cookies, or history, and it may reappear when you
return to the page.</p>
<p>That data stays on your device and is not transmitted to us. Clearing your
browser history or the site's stored data removes it.</p>

<h2>3. REAL Solutions Lead Gen Monitor (our Gmail application)</h2>
<p>This application reads Google mail for one account only: our own REAL
Solutions business mailbox. It looks for commercial property listings and
broker broadcast emails so that those leads can be captured into our own CRM.</p>
<p><strong>It does not read, collect, or store any third party's mail.</strong>
It is not offered as a service that connects to other people's inboxes.</p>

<h3>Google user data</h3>
<ul>
  <li><strong>What it accesses:</strong> the contents and metadata of messages
      in the REAL Solutions business mailbox it has been authorized against,
      through the Gmail API.</li>
  <li><strong>Why:</strong> to identify commercial property listings and broker
      broadcasts and extract the property details from them.</li>
  <li><strong>Where it goes:</strong> the extracted lead details are written
      into our own CRM. Message data is not retained beyond what is needed to
      do that.</li>
  <li><strong>Who sees it:</strong> REAL Solutions only.</li>
</ul>

<h3>Limited Use</h3>
<p>REAL Solutions' use and transfer of information received from Google APIs
adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google
API Services User Data Policy</a>, including the Limited Use requirements.
Specifically:</p>
<ul>
  <li>We use data obtained from Google APIs <strong>only</strong> to provide and
      improve the user-facing features described above.</li>
  <li>We do <strong>not</strong> transfer that data to others, except as
      necessary to provide or improve those features, for security purposes
      such as investigating abuse, to comply with applicable law, or as part of
      a merger or acquisition with prior explicit consent.</li>
  <li>We do <strong>not</strong> use it for advertising of any kind &mdash;
      including retargeting, personalized, or interest-based advertising
      &mdash; and we do not sell it or transfer it to data brokers or
      information resellers.</li>
  <li>We do <strong>not</strong> allow humans to read it, except with
      affirmative consent to view specific messages, where necessary for
      security purposes, where necessary to comply with applicable law, or
      where the data is aggregated and used for internal operations.</li>
</ul>

<h2>4. Security</h2>
<p>API credentials and tokens are held in the server environment configuration
of the systems that use them. They are not embedded in software we
distribute.</p>

<h2>5. Changes</h2>
<p>If we change how our software handles data, we will update this page and the
effective date above. If a change affects how we use Google user data, we will
seek consent before putting the new use into effect.</p>

<h2>6. Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
`);

const TERMS = layout('Terms of Service', `
<h1>Terms of Service</h1>
<p class="meta">REAL Solutions LLC &middot; Effective ${EFFECTIVE_DATE}</p>

<h2>1. What these terms cover</h2>
<p>These terms apply to the software and web applications REAL Solutions LLC
makes available, including the REAL Solutions Lead Gen Monitor. Using them
means you accept these terms.</p>

<h2>2. The software runs on your machine</h2>
<p>Software we release to others is locally hosted: it runs on your own computer
and your data stays there. We do not operate a service that holds your data,
and we have no ability to retrieve it. Backing up your own data is therefore
your responsibility.</p>

<h2>3. Acceptable use</h2>
<p>Use the software lawfully. Do not use it to infringe anyone's rights, to
reach systems or accounts you are not authorized to reach, or to break the
terms of any third-party service it connects to.</p>

<h2>4. Third-party services</h2>
<p>Some tools connect to third-party services such as Google Workspace and
GoHighLevel. Your use of those services is governed by their own terms. We are
not responsible for their availability or for how they handle data.</p>

<h2>5. Intellectual property</h2>
<p>We retain ownership of the software. You may use it for its intended purpose.
You may not resell it or redistribute it as your own.</p>

<h2>6. No warranty</h2>
<p>The software is provided "as is", without warranties of any kind, express or
implied, including merchantability, fitness for a particular purpose, and
non-infringement. We do not warrant that it will be uninterrupted or
error-free.</p>

<h2>7. Limitation of liability</h2>
<p>To the fullest extent permitted by law, REAL Solutions LLC is not liable for
indirect, incidental, special, or consequential damages, or for lost profits or
lost data, arising from use of the software. Our total liability for any claim
will not exceed the amount you paid us for the software in the twelve months
before the claim.</p>

<h2>8. Termination</h2>
<p>You may stop using the software at any time. We may discontinue it, or
withdraw access, if these terms are breached.</p>

<h2>9. Changes</h2>
<p>We may update these terms. The effective date above shows when they last
changed.</p>

<h2>10. Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
`);

function send(res: Response, html: string) {
  res.type('html').set('Cache-Control', 'public, max-age=300').send(html);
}

export function registerLegalRoutes(app: Express): void {
  app.get('/home', (_req: Request, res: Response) => send(res, HOME));
  app.get('/privacy', (_req: Request, res: Response) => send(res, PRIVACY));
  app.get('/terms', (_req: Request, res: Response) => send(res, TERMS));
}

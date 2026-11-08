# Mail and registration

[Back to README](../../README.md) · [Русский](../ru/mail-and-registration.md)

AIDis sends letters for two things: confirming the e-mail of a new account and password reset.
Without mail everything else works; accounts are then created by an administrator.

## Set up mail (SMTP)

You need an SMTP account: the mail of your domain (most domain registrars and hosting panels offer
one), a mail service for applications, or any mailbox that allows SMTP access with a password.

**Settings -> Administration -> Mail**:

| Field | Example |
| --- | --- |
| SMTP server | `smtp.example.com` |
| Port and encryption | `465` with TLS, or `587` with STARTTLS |
| Login, password | the mailbox login and its password (or app password) |
| Sender name | `AIDis` |
| Sender address | `noreply@example.com` (must be allowed for that login) |

**Save**, then **Send a test letter** to your own address. Mail counts as working only after a test
letter went through ("Checked ..." appears). The password is stored encrypted and never shown again;
leave the field empty to keep it.

Tips:

- Many VPS providers block outgoing port 25; use 465 or 587.
- Letters land in spam? Add SPF and DKIM records for the sender domain as your mail provider
  describes.
- Gmail and similar services need an "app password", not your normal one.

## Registration modes

**Settings -> Administration -> Registration**:

| Mode | Who can sign up | Needs mail |
| --- | --- | --- |
| Off | nobody; an administrator creates accounts (Administration -> Users) | no |
| By invite | people with a working invite link of a server; after confirming the e-mail they are on that server | yes |
| Open | anyone, from the login page | yes |

A new account can only log in after confirming the e-mail (the link works 24 hours).

## Password reset

With mail set up, the login page shows **Forgot your password?**: a link (valid 1 hour) goes to the
account's e-mail. Without mail, an administrator resets the password in **Administration -> Users**
and gives the new one to the person.

People change their own e-mail in **Settings -> My account** (a confirmation letter goes to the new
address).

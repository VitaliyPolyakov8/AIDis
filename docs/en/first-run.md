# First run

[Back to README](../../README.md) · [Русский](../ru/first-run.md)

## The wizard

Open the link the installer printed: `https://chat.example.com/setup?code=...`. Until the wizard is
finished, every page of the site shows it, and only the person with the code can finish it (the code
was printed on the VPS; `sudo cat /opt/aidis/Server/config/setup-code` shows it again).

1. **Code from the installation.** Already filled in when you came through the link.
2. **Administrator account.** Login (Latin letters, digits, `_`, `.` and `-`, 2 to 32
   characters), display name, password (at least 8 characters) and, optionally, an e-mail for password reset later.
3. **First server.** Its name, for example the name of your group. Everything can be renamed later.
4. **Registration.** Who may create accounts:
   - **Off**: only you create accounts (Administration -> Users);
   - **By invite**: anyone with a working invite link of a server;
   - **Open**: anyone who opens the site.

   "By invite" and "Open" start working after mail is set up, because new people confirm their
   e-mail ([Mail and registration](mail-and-registration.md)). Until then, "Off" behaves as usual.

After **Finish setup** you are logged in and see the invite link of your server. Copy it and send it
to your friends. The wizard is gone for good: the code no longer works and the next visitors see the
login page.

## Inviting people

- With registration **by invite** or **open**: send the invite link; people sign up from it and land
  on your server after confirming their e-mail.
- With registration **off**: create the accounts in **Settings -> Administration -> Users -> Create**
  and send each person their user name, the initial password and the invite link.

New invite links: click the server name at the top left -> **Invite people** (you can limit the
number of uses and the lifetime).

## The administration panel

**Settings (gear at the bottom left) -> Administration** is visible only to administrators:

| Section | What you do there |
| --- | --- |
| Overview, Online, Storage | health of the services, who is online, disk use |
| Users | create accounts, reset passwords, disable accounts, make administrators |
| All servers, Limits | every server on this AIDis, limits for new servers and uploads |
| Mail, Registration | SMTP and the registration mode |
| Voice servers | extra LiveKit servers ([Voice](voice.md)) |
| Audit log | who changed what |
| Announcement | a banner for everyone |

Roles and channels of a particular server are in that server's settings (click its name at the top left
-> **Server settings**).

## Next

- Install the [desktop app](desktop-app.md) (optional; the site works in any browser).
- Set up [mail](mail-and-registration.md) if you want self sign-up or password reset by e-mail.
- Plan [backups](backups.md).

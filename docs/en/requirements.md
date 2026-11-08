# Requirements

[Back to README](../../README.md) · [Русский](../ru/requirements.md)

## A VPS

| | Minimum | Comfortable |
| --- | --- | --- |
| System | Ubuntu 22.04 or 24.04, 64-bit | the same |
| CPU | 1 vCPU | 2 vCPU |
| Memory | 2 GB | 4 GB |
| Disk | 20 GB | 40 GB or more (uploaded files live here) |
| Network | a public IPv4 address | the same, 100 Mbit/s or faster |

- About 10 people talking at the same time is fine on the minimum. Screen sharing to many viewers
  needs more upload bandwidth than CPU.
- Pick a data center close to most of your friends: voice delay depends on it. You can add voice
  servers in other places later ([Voice](voice.md)).
- You need `root` (or `sudo`) and SSH access. The installer works on a VPS that already hosts other
  sites behind nginx (see [Installation](install.md#a-vps-that-already-runs-nginx)).

## A domain

Any domain or subdomain you control, for example `chat.example.com`. Create these DNS records at
your domain registrar (or DNS provider) **before** running the installer:

| Type | Name | Value | Needed for |
| --- | --- | --- | --- |
| A | `chat.example.com` | the IPv4 address of the VPS | the site, the API, the apps |
| A | `rtc.chat.example.com` | the same address | voice and video (skip if you install without voice) |

DNS changes can take from a minute to an hour to reach everyone. Check with:

```bash
getent hosts chat.example.com rtc.chat.example.com
```

Both lines must show the address of your VPS.

## Ports

The installer opens these in `ufw` when `ufw` is active. Many VPS providers also have their own
firewall in the control panel: open the same ports there.

| Port | Protocol | What for |
| --- | --- | --- |
| 80 | TCP | Let's Encrypt certificate checks, redirect to https |
| 443 | TCP | the site, the API, the apps, voice signaling |
| 17881 | TCP | voice media over TCP (fallback for strict networks) |
| 50000-50100 | UDP | voice and video media |
| 13478 | UDP | TURN (voice for people behind strict NAT) |

When a port is already used by another program on the VPS, the installer picks the next free one and
prints the final list at the end. Use that list for the provider firewall.

## On your computer

Nothing special: an SSH client (Windows 10/11 has `ssh` in PowerShell) and a browser. The Windows
app is optional; AIDis works in Chrome, Edge, Firefox and Safari, also on phones.

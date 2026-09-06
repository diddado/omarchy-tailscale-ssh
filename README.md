# Tailscale SSH

An Omarchy bar widget that lists the machines on your tailnet and opens an SSH
terminal into any of them, working out the login user for you.

![Tailscale SSH panel](preview.png)

Omarchy's built-in Tailscale widget shows your machines and copies their
addresses. This one connects to them.

## Why the rules are not just a list of hostnames

Autoscaled machines join and leave a tailnet under names nobody chose:

```
app-worker-i-0b1e031df86719510    tag:role-worker
media-encoder-i-03a09331616e96f5d tag:role-encoder
```

You cannot write those down — they will be different tomorrow. So rules match on
**hostname prefix, ACL tag, regex, or exact hostname**, and setup works out which
of those your tailnet needs.

## Install

```bash
omarchy plugin add https://github.com/diddado/omarchy-tailscale-ssh.git --enable
```

Then click the `>_` icon in the bar and press **Run setup**.

Setup reads your tailnet, groups the machines it finds, and asks which user to
log in as for each group. It never guesses a username: a wrong `ubuntu` that
looks like it was detected is worse than a blank you were asked to fill in.

You can re-run it any time:

```bash
~/.config/omarchy/plugins/io.github.diddado.tailscale-ssh/bin/setup
```

Requires the `tailscale` CLI. `wl-copy` is needed for the copy actions and `gum`
for the setup wizard; both ship with Omarchy.

## Using it

| | |
|---|---|
| Click the icon | Open the machine list |
| Type | Filter by name, label, group, user, IP, or tag |
| `Enter` | SSH into the selected machine |
| Terminal button | SSH into that machine |
| Gear button, or `Alt+E` | Configure the login user for that machine |
| `Alt+Y` / `Alt+C` | Copy the `ssh …` command / the Tailscale IP |
| `Alt+R` | Reload the machine list and the rules file |
| `Esc` | Clear the filter, then close |

Connections open in your default terminal with a per-machine window id
(`org.omarchy.tailssh-<machine>`), so Hyprland window rules can target them.

## Configuring

Most changes are one click: the **gear** on any row opens a small form for the
SSH user, port, and a command to run on connect. The **Apply to** chips decide
how far the change reaches — just that machine, everything sharing its prefix,
or everything carrying one of its tags. Configuring one member of a fleet
configures the fleet.

The panel header has a **?** that opens this documentation in your browser and a
**pencil** that opens the rules file in your editor. The file itself starts with
a `_readme` block listing every matcher and field, so the options are in front of
you while you edit — no need to come back here. That block is rewritten by the
plugin on each save, so it stays in step with the installed version.

The rules file lives at:

```
~/.local/state/omarchy/settings/io.github.diddado.tailscale-ssh.json
```

Edits apply immediately — no restart.

```json
{
  "version": 2,
  "defaultUser": "you",
  "sshArgs": ["-o", "ServerAliveInterval=30"],
  "tailnets": {
    "tailabc123.ts.net": {
      "name": "acme.com",
      "rules": [
        { "prefix": "app-", "user": "ubuntu", "group": "App tier" },
        { "prefix": "app-worker-", "group": "Workers" },
        { "tag": "role-db", "user": "postgres" },
        { "regex": "^db-\\d+$", "port": 2222 },
        { "host": "desktop", "user": "chris", "label": "Desktop", "group": "Home" }
      ]
    }
  }
}
```

### More than one Tailscale account

Rules live under `tailnets`, keyed by the tailnet's MagicDNS suffix. Switching
accounts changes the machines completely, so rules written for one tailnet would
be meaningless — and actively misleading — on another.

Switch to a tailnet the plugin has not seen, and the panel says so and offers to
set it up. Running setup adds a section for that tailnet and **leaves every other
section untouched**, so you can keep one configuration per account and switch
freely.

`defaultUser` and `sshArgs` at the top level apply everywhere; a tailnet can
override `defaultUser` and adds to `sshArgs`.

The key is the MagicDNS suffix rather than the account name because it is unique,
survives a tailnet rename, and is readable from an unprivileged
`tailscale status`. Listing accounts (`tailscale switch --list`) needs root or an
operator grant, so the plugin never depends on it.

### How rules combine

Each rule carries exactly one matcher:

| Matcher | Matches |
|---|---|
| `host` | Exact machine name or full MagicDNS name, case-insensitive |
| `tag` | A Tailscale ACL tag; the `tag:` prefix is optional |
| `regex` | JavaScript regex against the machine name |
| `prefix` | Machine-name prefix — the **longest** match wins |

Matching rules are applied weakest to strongest:

```
defaults  <  prefix  <  regex  <  tag  <  host
```

They **merge** rather than compete. A prefix rule can set the user for a whole
fleet while an exact-host rule overrides only that one machine's port; fields you
do not mention are inherited rather than reset. `sshArgs` accumulate across
tiers, so a global keepalive survives a rule that adds an identity file.

### Rule fields

All optional, all settable at any tier:

| Field | Effect |
|---|---|
| `user` | SSH login user |
| `port` | `ssh -p` |
| `sshArgs` | Extra flags — an array, or a string split on whitespace |
| `command` | Run this on arrival instead of a login shell (adds `ssh -t`) |
| `label` | Friendlier display name |
| `group` | Section heading to file the machine under |
| `address` | Override what ssh connects to |
| `hidden` | `true` drops the machine from the list |

Top level: `defaultUser`, `sshArgs`, `connectVia`, `rules`.

### Landing in tmux instead of a login shell

`command` runs something on arrival. The plugin adds `ssh -t` for you, which
allocates the TTY that a full-screen program needs:

```json
{ "host": "build-runner", "command": "tmux new -A -s work" }
```

`tmux new -A -s work` attaches to the session named `work`, **creating it first
if it does not exist** — that `-A` is what makes it safe to use as a connect
command. Without it, `tmux new -s work` fails the second time you connect
because the session is already there.

Since rules merge, one line gives it to a whole fleet:

```json
{ "prefix": "app-worker-", "user": "ubuntu", "command": "tmux new -A -s ops" }
```

Other things worth putting there:

```json
{ "tag": "role-db",  "command": "sudo -u postgres psql" }
{ "host": "logs-01", "command": "journalctl -fu myapp" }
{ "host": "docker-1","command": "sudo docker compose logs -f" }
```

A machine with a `command` shows it in the panel with a `↦` marker, so you can
see at a glance which rows do something other than open a shell.


## Widget settings

Stored inline on the widget's entry in `~/.config/omarchy/shell.json`:

```bash
omarchy bar set io.github.diddado.tailscale-ssh refreshIntervalSec 60 --json
omarchy bar set io.github.diddado.tailscale-ssh connectVia ip
```

| Key | Default | Purpose |
|---|---|---|
| `refreshIntervalSec` | `30` | How often `tailscale status` is polled |
| `configPath` | *(state dir)* | Move the rules file elsewhere |
| `defaultUser` | *(local user)* | Fallback when no rule matches |
| `connectVia` | `dns` | `dns` \| `ip` \| `hostname` |
| `showOffline` | `true` | List offline machines, dimmed |
| `focusFilterOnOpen` | `true` | Type to filter the moment the panel opens |

Numbers and booleans need `--json`, or they land in `shell.json` as strings.

## Removing

```bash
omarchy plugin remove io.github.diddado.tailscale-ssh
rm ~/.local/state/omarchy/settings/io.github.diddado.tailscale-ssh.json
```

The second line matters: nothing removes plugin state automatically, and
uninstalling does not delete your rules.

## Security

The plugin only ever *reads* `tailscale status --json`. It never brings the
tailnet up or down and needs no elevated privileges.

Hostnames, usernames, and `sshArgs` come from the network and from a config
file, so nothing is ever interpolated into a shell string. Commands are built as
argv vectors and run through `bash -lc 'exec "$@"'`, which leaves arguments in
positional parameters where they cannot be re-tokenized.

## Development

```bash
./scripts/dev-install.sh          # symlink this checkout into Omarchy
node test/model.test.js           # rule engine
bash test/setup.test.sh           # config generator, against fixture tailnets
omarchy plugin validate .         # manifest schema
omarchy restart shell             # reload after a QML edit
```

`Model.js` holds the pure logic and carries the tests; `bin/setup` holds the
generator and depends only on bash and `jq`. `Service.qml` owns subprocesses and
config I/O, `Panel.qml` is presentation and the keyboard cursor model.

A note that will save you time: editing a bar widget's QML needs
`omarchy restart shell`. The inotify watcher fires and
`omarchy-shell shell rescanPlugins` reloads the manifest, but neither swaps the
QML of a widget that is already mounted. That is why most of the logic lives in
`Model.js`, where the test loop is instant.

## License

MIT — see [LICENSE](LICENSE).

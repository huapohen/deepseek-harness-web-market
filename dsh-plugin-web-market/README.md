# DSH Web Market Host

This private bundle mounts Anywhere Labs' `dsh-community-market` in the normal
DeepSeek Harness Web profile. It supplies the local profile, package operation,
plugin inventory, enable/disable, terminal, and restart capabilities that the
market otherwise receives from the Electron desktop shell.

The runtime operates only on the active `web` profile under `DSH_HOME`. Package
operations invoke the same installed DSH CLI entry that booted the Web server;
they do not depend on a globally discoverable shell command.

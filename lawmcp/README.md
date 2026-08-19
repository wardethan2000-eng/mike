# Statute and web lookup service

Mike cannot reach the internet on its own. This small service gives it a
narrow, controlled way to do so, and is connected to Mike as an MCP connector.

It reads statutes from official sources — Kansas, Missouri, Texas and Colorado
each have their own lookup — and can search the web and read a page. Only sites
on a fixed list can be read; anything else, including anything on the local
network, is refused.

Oklahoma is deliberately absent. Both the Oklahoma Legislature's site and OSCN
tell automated visitors to stay out of the whole site, so neither is read. Ask
the user to paste or upload an Oklahoma statute instead.

Texas is read from `tcss.legis.texas.gov`, not from the public statutes site:
that site is now a JavaScript application whose pages contain no statute text
at all.

Colorado is read from `olls.info`, where the state's own Office of Legislative
Legal Services publishes a file per title. The state's main site only links out
to a paid publisher. A title is several megabytes, so each one is kept on disk
under `/var/cache/lawmcp` after the first lookup.

## Running it

It runs on the app server, not in Docker: `/opt/lawmcp/law_mcp.py`, started by
the `lawmcp` systemd unit, and served to Mike on the public address under
`/_mcp` behind a bearer token. Settings live in `/etc/lawmcp.env`, which holds
that token and is not in this repository.

This copy exists so the service is version-controlled and can be restored.
After changing it, copy it to `/opt/lawmcp/` and restart the `lawmcp` unit.

Adding a tool is not enough on its own — Mike only sees tools it has been told
about, so refresh the connector afterwards from Mike's own settings.

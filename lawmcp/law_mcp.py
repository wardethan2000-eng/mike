#!/usr/bin/env python3
"""A small MCP server that lets Mike read statutes from official sources.

Mike cannot reach the web on its own. This gives it a narrow, controlled way to
do so: it may fetch pages from a fixed list of official legislature and
government sites, and nothing else. It is not a general web browser, and it
cannot be used to reach the local network.

Sites are included only where the site's own robots.txt permits automated
access. Oklahoma's OSCN is deliberately excluded because it disallows crawling;
the Oklahoma Legislature's own sites are used instead.
"""

from __future__ import annotations

import os
import re
import urllib.parse

import ipaddress
import socket

import httpx
from bs4 import BeautifulSoup
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

MAX_BYTES = 3_000_000
TIMEOUT = 45

# Only these hosts may be fetched. Anything else is refused.
ALLOWED_HOSTS = {
    # Kansas
    "ksrevisor.gov", "www.ksrevisor.gov",
    # Missouri
    "revisor.mo.gov", "www.revisor.mo.gov",
    # Texas — statutes.capitol.texas.gov is now a JavaScript app whose pages
    # contain no statute text; tcss.legis.texas.gov is where it reads the
    # documents themselves from.
    "statutes.capitol.texas.gov", "capitol.texas.gov",
    "tcss.legis.texas.gov",
    # Colorado — leg.colorado.gov only links out to a commercial publisher;
    # olls.info is where the state's own legislative legal services office
    # publishes the official statutes, a file per title.
    "leg.colorado.gov", "www.leg.colorado.gov",
    "content.leg.colorado.gov", "olls.info",
    # Oklahoma (OSCN is excluded: its robots.txt disallows crawling)
    "oksenate.gov", "www.oksenate.gov",
    # oklegislature.gov and oscn.net both refuse automated visitors outright,
    # so neither is listed. Oklahoma statutes cannot be read by this tool.
    # Federal
    "www.ecfr.gov", "ecfr.gov",
    "uscode.house.gov", "www.govinfo.gov", "api.govinfo.gov",
    "www.courtlistener.com", "courtlistener.com",
}

URL_GUIDE = """
Known address patterns for building a url:

Kansas (K.S.A.) - chapter 3 digits, then the article and section from the part
after the dash: the last two digits are the section, the digits before them are
the article. K.S.A. 60-206 becomes 060_002_0006:
  https://ksrevisor.gov/statutes/chapters/ch60/060_002_0006.html

Missouri (RSMo) - by section number:
  https://revisor.mo.gov/main/OneSection.aspx?section=407.020

Texas - use the texas_statute tool. Its public site is now a JavaScript app
whose pages hold no statute text; the documents themselves are at:
  https://tcss.legis.texas.gov/resources/CP/htm/CP.16.htm

Colorado (C.R.S.) - use the colorado_statute tool. The state's own office
publishes a file per title; leg.colorado.gov only links to a paid publisher.

Oklahoma - there is NO lookup for Oklahoma. Both the Legislature's site and
OSCN tell automated visitors to stay out of the whole site, so this tool will
not read them. Say so plainly rather than answering from memory, and offer to
work from an Oklahoma statute the user pastes in or uploads.
"""

mcp = MCPServer("law-lookup", instructions=(
    "Read statutes and regulations from official government sources. "
    "Prefer these tools over recalling the wording of a law."
))


def _check_host(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http and https addresses can be fetched.")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        raise ValueError(
            f"{host or 'that address'} is not an approved source. "
            "This tool only reads official legislature and government sites: "
            + ", ".join(sorted(ALLOWED_HOSTS)[:8]) + ", and a few more."
        )
    return url


# Words that mark a block as site furniture rather than the law itself. Old
# government sites lay their menus out in plain divs and tables, so the usual
# <nav>/<header>/<footer> tags catch none of it and the menus end up both in
# the text the model reads and in any document saved from it.
_FURNITURE = re.compile(
    r"nav|menu|breadcrumb|header|footer|sidebar|side-?bar|banner|skip|"
    r"topnav|rightbar|toolbar|search",
    re.I,
)


def _looks_like_furniture(tag) -> bool:
    for value in (tag.get("id"), " ".join(tag.get("class") or [])):
        if value and _FURNITURE.search(value):
            return True
    return False


# Tags that sit inside a sentence rather than starting a new block. A statute
# usually links its cross-references ("K.S.A. 16-204"), and putting each link
# on its own line splits the sentence, so a perfectly good quotation no longer
# matches the source and gets flagged as unverified.
_INLINE_TAGS = [
    "a", "em", "strong", "span", "b", "i", "u", "sup", "sub",
    "font", "small", "abbr", "cite", "q", "mark", "time",
]


def _block_text(node) -> str:
    """Text with a line per block, and sentences left whole."""
    for tag in node.find_all(_INLINE_TAGS):
        tag.unwrap()
    node.smooth()
    return _tidy(node.get_text("\n"))


# Leftovers from a page's own controls: a lone arrow, bullet or bar that meant
# something as a button and means nothing as text.
_STRAY_LINE = re.compile(r"^[\s•·◦▪|<>«»‹›\-–—]+$")


def _tidy(text: str) -> str:
    text = text.replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    lines = ["" if _STRAY_LINE.match(line) else line for line in lines]
    text = "\n".join(lines)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()
    return text


def _decode(content: bytes, declared: str | None) -> str:
    """Text from bytes, believing the page's own declaration when the server
    does not give one."""
    if declared:
        return content.decode(declared, "replace")
    head = content[:4096].decode("ascii", "ignore").lower()
    match = re.search(r'charset=["\']?([a-z0-9_-]+)', head)
    if match:
        try:
            return content.decode(match.group(1), "replace")
        except LookupError:
            pass
    return content.decode("utf-8", "replace")


def _readable(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "nav", "header", "footer", "form", "noscript"]):
        tag.decompose()
    for tag in soup.find_all(["div", "table", "ul", "section", "aside", "p"]):
        if getattr(tag, "decomposed", False):
            continue
        if _looks_like_furniture(tag):
            tag.decompose()
    return _block_text(soup)


def _kansas_statute_text(html: str):
    """Just the statute, from a Kansas Revisor page.

    The page carries the section, its caption and history in one block, then
    the law review notes and case annotations as separate paragraphs. Everything
    else on the page is menus. Returns None if the page is not laid out the way
    we expect, so the caller falls back to reading the whole page.
    """
    soup = BeautifulSoup(html, "lxml")
    body = soup.select_one("div#print")
    if body is None:
        return None
    parts = [_block_text(body)]
    for note in soup.select("p.ksa_8pt_title, p.ksa_8pt_body, p.ksa_8pt_ca"):
        parts.append(_block_text(note))
    text = _tidy("\n\n".join(part for part in parts if part))
    return text or None


def _missouri_statute_text(html: str):
    """Just the section, from a Missouri Revisor page.

    Everything sits in one block; the menus, the search box and the footer are
    separate pieces inside it with known ids. Returns None if the page is not
    laid out the way we expect.
    """
    soup = BeautifulSoup(html, "lxml")
    body = soup.select_one(".lr-body")
    if body is None:
        return None
    for junk_id in ("dtls", "TOP", "BOTTOM", "Div1", "links", "search",
                    "barw", "farw", "homeHyperLink", "homeicon"):
        found = soup.find(id=junk_id)
        if found is not None and not getattr(found, "decomposed", False):
            found.decompose()
    # The search box has no usable id of its own; it is the small block that
    # carries the search button's wording.
    for block in body.find_all("div"):
        if getattr(block, "decomposed", False):
            continue
        text = block.get_text(" ", strip=True)
        if len(text) < 120 and "Do search" in text:
            block.decompose()
    text = _block_text(body)
    return text or None


def _texas_statute_text(html: str):
    """A Texas code chapter. The document itself is plain, so this only keeps
    the page from being read as one long run-on."""
    soup = BeautifulSoup(html, "lxml")
    text = _block_text(soup)
    return text or None


def _fetch(url: str, extract=None) -> str:
    _check_host(url)
    with httpx.Client(
        timeout=TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": "Mike-legal-research (self-hosted; contact site owner to opt out)"},
    ) as client:
        r = client.get(url)
        # A redirect must not carry us off the approved list.
        _check_host(str(r.url))
        r.raise_for_status()
        content = r.content[:MAX_BYTES]

    ctype = r.headers.get("content-type", "")
    if "pdf" in ctype:
        return (
            f"[{url} is a PDF and cannot be read as text by this tool. "
            "Download it and upload it to the library instead.]"
        )
    html = _decode(content, r.charset_encoding)
    if extract is not None:
        picked = extract(html)
        if picked:
            return picked
    return _readable(html)


@mcp.tool(description=(
    "Read the text of a page from an official statute or government website. "
    "Use this to read the actual wording of a statute or regulation instead of "
    "relying on memory. Only official legislature and government sites can be "
    "read; anything else is refused." + URL_GUIDE
))
def fetch_law(url: str) -> str:
    try:
        text = _fetch(url)
    except ValueError as exc:
        return f"Refused: {exc}"
    except Exception as exc:
        return f"Could not read {url}: {exc}"
    return f"Source: {url}\n\n{text[:120_000]}"


@mcp.tool()
def kansas_statute(citation: str) -> str:
    """Read a Kansas statute by its citation, for example "60-206" or "K.S.A. 21-5801".

    Works out the address on the Kansas Revisor of Statutes site and returns the
    section text.
    """
    # Kansas section numbers come in two shapes:
    #   plain     60-206     -> article 002, section 0006  (last two digits are the section)
    #   lettered  17-12a501  -> article 012a, section 0501 (digits after the letter are
    #                           the section; the letter belongs to the ARTICLE)
    lettered = re.search(r"(\d+)\s*-\s*(\d+)([a-zA-Z])(\d+)", citation)
    if lettered:
        chapter, art, letter, sec = lettered.groups()
        number = f"{art}{letter}{sec}"
        slug = f"{int(chapter):03d}_{int(art):03d}{letter.lower()}_{int(sec):04d}"
    else:
        m = re.search(r"(\d+)\s*-\s*(\d+)([a-zA-Z]?)", citation)
        if not m:
            return 'Could not read that citation. Use a form like "60-206" or "K.S.A. 21-5801".'
        chapter, digits, suffix = m.group(1), m.group(2), m.group(3)
        if len(digits) < 3:
            return f"{citation} does not look like a Kansas section number."
        article, section = digits[:-2], digits[-2:]
        number = f"{digits}{suffix}"
        slug = f"{int(chapter):03d}_{int(article):03d}_{int(section):04d}{suffix}"
    url = f"https://ksrevisor.gov/statutes/chapters/ch{chapter}/{slug}.html"
    text = _fetch(url, extract=_kansas_statute_text)
    return f"K.S.A. {chapter}-{number}\nSource: {url}\n\n{text[:120_000]}"


@mcp.tool(description=(
    "Read a chapter of a Texas code, for example code \"CP\" chapter \"16\" for "
    "Civil Practice and Remedies Code chapter 16. Codes are the usual "
    "abbreviations: CP, PE (Penal), FA (Family), PR (Estates), BC (Business "
    "and Commerce), CV (Civil Statutes), GV (Government), HS (Health and "
    "Safety), IN (Insurance), LA (Labor), OC (Occupations), PW (Property), "
    "TX (Tax), TN (Transportation). Returns the whole chapter, so look for "
    "the section you want inside it."
))
def texas_statute(code: str, chapter: str) -> str:
    code_clean = re.sub(r"[^A-Za-z]", "", code).upper()
    chapter_clean = re.sub(r"[^0-9A-Za-z.]", "", chapter)
    if not code_clean or not chapter_clean:
        return 'Could not read that. Give a code and a chapter, like "CP" and "16".'
    url = (
        "https://tcss.legis.texas.gov/resources/"
        f"{code_clean}/htm/{code_clean}.{chapter_clean}.htm"
    )
    try:
        text = _fetch(url, extract=_texas_statute_text)
    except Exception as exc:
        return f"Could not read Texas {code_clean} chapter {chapter_clean}: {exc}"
    return (
        f"Texas {code_clean} chapter {chapter_clean}\nSource: {url}\n\n"
        f"{text[:120_000]}"
    )


LAW_USER_AGENT = "Mike-legal-research (self-hosted; contact site owner to opt out)"
CRS_CACHE = "/var/cache/lawmcp"
CRS_YEARS = (2026, 2025, 2024)


def _crs_title_text(title_no: int) -> tuple[str, str]:
    """One Colorado title as text, kept on disk because each is several
    megabytes and a title rarely changes more than once a year."""
    os.makedirs(CRS_CACHE, exist_ok=True)
    for year in CRS_YEARS:
        cached = os.path.join(CRS_CACHE, f"crs{year}-title-{title_no:02d}.txt")
        url = f"https://olls.info/crs/crs{year}-title-{title_no:02d}.htm"
        if os.path.exists(cached):
            with open(cached, encoding="utf-8") as handle:
                return handle.read(), url
        _check_host(url)
        with httpx.Client(timeout=180, follow_redirects=True,
                          headers={"User-Agent": LAW_USER_AGENT}) as client:
            response = client.get(url)
            if response.status_code == 404:
                continue
            response.raise_for_status()
            body = response.content
        text = _readable(_decode(body, response.charset_encoding))
        with open(cached, "w", encoding="utf-8") as handle:
            handle.write(text)
        return text, url
    raise ValueError(f"No published file for Colorado title {title_no}.")


def _crs_section(text: str, section: str) -> str | None:
    """The one section out of a whole title.

    The number turns up many times over — in the list of contents, in
    cross-references, and all through the case annotations. The real thing
    starts a line, is followed by the section's own heading, and then by
    numbered subsections. The contents list looks the same but is followed
    straight away by the next section number, so it is ruled out that way.
    """
    escaped = re.escape(section)
    # A heading stands on its own after a blank line. A cross-reference to
    # another section can wrap onto a new line and look identical, which is
    # why the blank line matters: without it the law was cut off mid-sentence
    # at the first citation that happened to wrap.
    heading = re.compile(r"(?<=\n\n)" + escaped + r"\.(?!\d)[ \t]*\S")
    following = re.compile(r"(?<=\n\n)\d+-\d+-\d+(?:\.\d+)?\.")
    for match in reversed(list(heading.finditer(text))):
        start = match.start()
        nxt = following.search(text, start + len(section) + 2)
        end = nxt.start() if nxt else min(len(text), start + 60_000)
        block = text[start:end]
        # A contents entry runs to the next number within a line or two; the
        # law itself carries subsections and runs much longer.
        if len(block) < 300:
            continue
        if not re.search(r"(?m)^\(1\)|\(1\)[ \t]", block):
            continue
        return _tidy(block)
    return None


@mcp.tool(description=(
    "Read a Colorado statute by its citation, for example \"13-80-102\" or "
    "\"C.R.S. 38-12-102\". Reads the official text published by the Colorado "
    "Office of Legislative Legal Services."
))
def colorado_statute(citation: str) -> str:
    match = re.search(r"(\d+)\s*-\s*(\d+)\s*-\s*(\d+(?:\.\d+)?)", citation)
    if not match:
        return ('Could not read that citation. Use a form like "13-80-102" '
                'or "C.R.S. 38-12-102".')
    section = f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    try:
        text, url = _crs_title_text(int(match.group(1)))
    except ValueError as exc:
        return f"Refused: {exc}"
    except Exception as exc:
        return f"Could not read Colorado title {match.group(1)}: {exc}"
    body = _crs_section(text, section)
    if not body:
        return (f"C.R.S. {section} was not found in title {match.group(1)}. "
                "Check the number, or the section may have been repealed.")
    return f"C.R.S. {section}\nSource: {url}\n\n{body[:120_000]}"


@mcp.tool()
def missouri_statute(section: str) -> str:
    """Read a Missouri statute by section number, for example "407.020"."""
    m = re.search(r"(\d+\.\d+)", section)
    if not m:
        return 'Could not read that section. Use a form like "407.020".'
    url = f"https://revisor.mo.gov/main/OneSection.aspx?section={m.group(1)}"
    text = _fetch(url, extract=_missouri_statute_text)
    return f"RSMo {m.group(1)}\nSource: {url}\n\n{text[:120_000]}"


@mcp.tool()
def approved_sources() -> str:
    """List the websites this tool is allowed to read, and the address patterns."""
    return "Approved sources:\n" + "\n".join(
        f"  - {h}" for h in sorted(ALLOWED_HOSTS)
    ) + "\n" + URL_GUIDE + (
        "\nOklahoma's OSCN is deliberately not included: its robots.txt asks "
        "automated tools not to read it."
    )


SEARCH_URL = os.environ.get("LAW_MCP_SEARCH_URL", "http://127.0.0.1:8888/search")


def _public_address_only(url: str) -> str:
    """Refuse anything that resolves to this machine or the local network.

    `fetch_page` can reach the whole internet, so it must not become a way to
    read things behind the firewall - the Proxmox console, other machines here,
    or a cloud metadata service.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http and https addresses can be read.")
    host = parsed.hostname
    if not host:
        raise ValueError("That address has no host in it.")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise ValueError(f"Could not look up {host}.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError(
                f"{host} is on a private or local network and will not be read."
            )
    return url


def _fetch_any(url: str) -> str:
    _public_address_only(url)
    with httpx.Client(
        timeout=TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": "Mozilla/5.0 (compatible; Mike-legal-research)"},
    ) as client:
        r = client.get(url)
        _public_address_only(str(r.url))
        r.raise_for_status()
        content = r.content[:MAX_BYTES]
    if "pdf" in r.headers.get("content-type", ""):
        return f"[{url} is a PDF. Download it and upload it to the library to read it.]"
    return _readable(content.decode(r.encoding or "utf-8", "replace"))


@mcp.tool(description=(
    "Search the web and get back a list of results with titles, addresses and "
    "short summaries. Use it for anything you do not already know or cannot "
    "find in the attached documents. Optionally restrict it to one website with "
    "`site`, for example site='ksrevisor.gov'. Follow up with fetch_page to read "
    "a result in full. Search results are ordinary web pages, not authority - "
    "for the wording of a law, use fetch_law or the statute tools instead."
))
def web_search(query: str, site: str | None = None, count: int = 8) -> str:
    q = f"site:{site} {query}" if site else query
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(SEARCH_URL, params={"q": q, "format": "json"})
            r.raise_for_status()
            data = r.json()
    except Exception as exc:
        return f"The search service did not respond: {exc}"

    results = data.get("results", [])[: max(1, min(count, 20))]
    if not results:
        return f"No results for: {q}"

    lines = [f"Search results for: {q}", ""]
    for i, item in enumerate(results, 1):
        lines.append(f"{i}. {item.get('title', '').strip()}")
        lines.append(f"   {item.get('url', '')}")
        snippet = (item.get("content") or "").strip().replace("\n", " ")
        if snippet:
            lines.append(f"   {snippet[:300]}")
        lines.append("")
    return "\n".join(lines)


@mcp.tool(description=(
    "Read the full text of any public web page. Use it after web_search to read "
    "a result properly instead of relying on the summary. Addresses on private "
    "or local networks are refused. A page found this way is ordinary web "
    "content, not authority - say where it came from when you rely on it."
))
def fetch_page(url: str) -> str:
    try:
        text = _fetch_any(url)
    except ValueError as exc:
        return f"Refused: {exc}"
    except Exception as exc:
        return f"Could not read {url}: {exc}"
    return f"Source: {url}\n\n{text[:120_000]}"


if __name__ == "__main__":
    mcp.run(
        "streamable-http",
        host=os.environ.get("LAW_MCP_HOST", "127.0.0.1"),
        port=int(os.environ.get("LAW_MCP_PORT", "8090")),
        streamable_http_path=os.environ.get("LAW_MCP_PATH", "/_mcp"),
        stateless_http=True,
        json_response=True,
        # Caddy forwards the public hostname; the SDK rejects unknown Host
        # headers by default as a guard against DNS rebinding.
        transport_security=TransportSecuritySettings(
            allowed_hosts=[
                h.strip()
                for h in os.environ.get(
                    "LAW_MCP_ALLOWED_HOSTS", "127.0.0.1:8090,localhost:8090"
                ).split(",")
                if h.strip()
            ],
            allowed_origins=["*"],
        ),
    )

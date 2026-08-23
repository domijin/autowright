// Shared app constants. The repo URL is one constant for the §9.4 About links
// and the §9.5 report modal — never two copies.
export const REPO_URL = 'https://github.com/hansololz/autowright'

// §5.1/§5.2 transfer (export / import) is parked in the UI: the §9.1 Import button and the
// §9.2 Export… row are hidden while this is true. Modals, §19 endpoints, and the §20 CLI are
// untouched and stay live. To un-park: flip this to false and un-skip the
// '§5.1/§9.1 import os-mismatch notes' describe in app/tests/automationslist.render.test.tsx.
export const TRANSFER_PARKED = true

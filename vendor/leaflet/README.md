# Vendored, not linked.

Leaflet 1.9.4 and Leaflet.markercluster 1.5.3, copied from npm and committed.

The map used to make no network calls at all — baked SVG outlines, no CDN, no
key — and that was deliberate: nothing could break it when somebody changed
their terms. Adding an imagery baselayer gives that up for the TILES, which is
the point of imagery and cannot be avoided.

It does not have to give it up for the CODE as well. A CDN outage or a version
yanked from npm would otherwise take the whole page down, imagery or not, and
Subresource Integrity only turns a silent break into a loud one. These files
are 198 KB together and they are checked in, so the only thing the page needs
from the network is the imagery — and when that fails the pins still draw in
the right places and the page says so.

Upgrading: `npm pack leaflet@<v>` and `npm pack leaflet.markercluster@<v>`,
copy dist/, re-run the map's own checks. Nothing here is modified from the
published dist files.

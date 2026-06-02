#pragma once

// Material/Map Browser grouping.
//
// The browser does not echo Category() verbatim — it splits the string on a
// backslash: the first segment selects the root node ("Materials" / "Maps")
// and the remainder names the sub-group. This mirrors Autodesk's own USD
// material, whose Category() returns "Materials\\USD" and lands under
// Materials > USD. A flat string (our old "max.js") has no root segment and
// falls through to the catch-all "General" bucket.
//
// THREEJS_BROWSER_GROUP is the only thing to change to rename the group.
#define THREEJS_BROWSER_GROUP _T("max.js")
#define THREEJS_MTL_CATEGORY  _T("Materials\\") THREEJS_BROWSER_GROUP
#define THREEJS_MAP_CATEGORY  _T("Maps\\") THREEJS_BROWSER_GROUP

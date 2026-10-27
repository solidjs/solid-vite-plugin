---
'@solidjs/vite-plugin': patch
---

Require solid-js / @solidjs/web 2.0.0-rc.14 (peer floor) and compile with @solidjs/compiler / @solidjs/babel-plugin rc.14 — runtime and compiler move in lockstep. rc.14 treats a lowercase `on*` name (`onclick`) as a plain attribute everywhere (both compilers, spread/assign, and the server spread walk); only `on` followed by an uppercase letter is an event handler, and a function handed to a lowercase `on*` attribute is escaped rather than bound. Server-component frame markup also moved: refetched content lands at the transition's commit. With the old `^2.0.0-rc.13` floor an existing lockfile could keep an rc.13 compiler while the app's runtime moved to rc.14, so compiled output and the frames runtime would disagree; the floor bump closes that window.

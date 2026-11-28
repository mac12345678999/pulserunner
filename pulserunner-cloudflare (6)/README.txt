Pulse Runner on Cloudflare Pages (with online accounts)

1. In the Cloudflare dashboard go to Storage & Databases > KV and create a namespace called pulserunner.
2. Go to Workers & Pages > Create > Pages > Upload assets. Upload this folder (index.html and _worker.js).
3. Open the new Pages project > Settings > Bindings (or Functions) > add a KV namespace binding.
   Variable name must be exactly: PR_KV   Namespace: pulserunner
4. Deploy again (upload the folder once more) so the binding takes effect.
5. Open your site, go to Profile. You should see Log in / Create account.

Without the binding or _worker.js the game still works, but accounts stay on this device only.
Cloudflare's dashboard changes sometimes, so check their Pages and KV docs if a menu has moved.

New in this version: real-player leaderboards (Time Trials, Speedruns, Cube Quest) use the same KV
namespace and need no extra setup. Ghosts you race come from the #1 real player; if nobody has posted yet,
the bot record is used. Times are submitted by the browser, so a determined cheater could fake one.

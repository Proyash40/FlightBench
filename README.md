# FlightBench — running it locally

ES6 modules require a real origin (http://), not file:// — browsers block
module imports over file://. Two easy options:

1. **Python** (works out of the box on most systems):
   cd flightbench
   python3 -m http.server 8000
   open http://localhost:8000

2. **Node** (if you have it):
   npx serve .

## GitHub Pages
Push this folder's contents to a repo and enable Pages on the branch/folder.
It will work directly since Pages serves over https.

## The QR code
Both the Pro-upgrade modal and the Donate modal reference `qr_ss.png`.
Add your own UPI QR code image to this folder with that exact filename,
or update the `src` in index.html if you'd rather name it differently.

## Testing the Pro unlock without a real payment
Open the browser console and run:
  localStorage.getItem('flightbench_deviceID')
to see the current device ID, then compute:
  Math.floor((deviceID * 95) / 2.6) + "-PRO"
to get a working key for that device — useful for your own QA, and worth
knowing because any user can do the same via DevTools (see the note at the
top of auth.js).

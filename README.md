# FlightBench 🚁

A zero-hardware, browser-based Arduino flight simulator and code testing bench. FlightBench allows developers and aerospace hobbyists to write standard C++ Arduino flight logic, compile it directly in the browser, and watch a virtual drone execute the commands in real-time.

## Features

**Core Engine (Free)**
* **In-Browser Transpiler:** Parses Arduino C++ (`setup()`, `loop()`, `delay()`) into non-blocking JavaScript coroutines.
* **TX-2 Ground Controller:** A Mode 2 radio transmitter dashboard with precision-machined visual gimbals.
* **Real-Time Telemetry:** Live serial monitor for debugging flight state outputs.
* **Chase Camera:** 2D/pseudo-3D perspective viewer mapping stick inputs to aircraft attitude.

**Pro Tier (Lifetime License)**
* **Advanced Flight Physics:** Integrates wind vectors, aerodynamic drag, and ground-effect cushioning.
* **High-Tech HUD:** Artificial horizon, heading tape, and altitude ladder overlaid on the chase view.
* **PID Tuning Suite:** Live step-response graphing for attitude-controller gain tuning (Kp, Ki, Kd).
* **Multi-Vehicle Support:** Toggle between Quadcopter and Hexacopter dynamics.
* **Oscilloscope:** 4-channel real-time graphing for Throttle, Pitch, Roll, and Yaw.

## Local Setup

FlightBench uses ES6 modules and must be served over `http://` (browsers block module imports over `file://`). 

1. Clone the repository.
2. Ensure you have added your UPI QR code image to the root directory and named it exactly `qr_ss.png`.
3. Start a local server. If you have Python installed, run:
   ```bash
   python3 -m http.server 8000

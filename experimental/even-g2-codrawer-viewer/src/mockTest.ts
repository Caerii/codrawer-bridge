// Combine the mock server and the viewer into a single process for
// convenience.  Running `npm test` will spin up a mock codrawer
// WebSocket server and concurrently launch the viewer.  Frames will
// be written to the `mock_output` directory.

import "./mockServer";
import "./main";
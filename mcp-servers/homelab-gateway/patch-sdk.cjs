const fs = require('fs');
const FILES = [
  "node_modules/@modelcontextprotocol/sdk/dist/cjs/server/webStandardStreamableHttp.js",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js"
];

for (const FILE of FILES) {
  let content = fs.readFileSync(FILE, 'utf8');

  // Replace the POST handler check
  content = content.replace(
    /if \(!acceptHeader\?\.includes\('application\/json'\) \|\| !acceptHeader\.includes\('text\/event-stream'\)\)/g,
    "if (acceptHeader !== '*/*' && (!acceptHeader?.includes('application/json') || !acceptHeader.includes('text/event-stream')))"
  );

  // Replace the GET handler check
  content = content.replace(
    /if \(!acceptHeader\?\.includes\('text\/event-stream'\)\)/g,
    "if (acceptHeader !== '*/*' && !acceptHeader?.includes('text/event-stream'))"
  );

  fs.writeFileSync(FILE, content);

  // Verify
  const verify = fs.readFileSync(FILE, 'utf8');
  console.log(FILE + ':', verify.includes("acceptHeader !== '*/*'") ? 'PATCHED' : 'FAILED');
}

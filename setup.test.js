// node --test setup.test.js
const test = require('node:test');
const assert = require('node:assert');
const { upsertEnvBlock } = require('./setup.js');

test('env block is appended once, then replaced in place', () => {
  const first = upsertEnvBlock('alias ll="ls -l"\n', { A: '1', B: "it's" });
  assert.strictEqual(first, `alias ll="ls -l"\n\n# TGClaudeBridge\nexport A='1'\nexport B='it'\\''s'\n# TGClaudeBridge end\n`);
  const second = upsertEnvBlock(`${first}export PATH=x\n`, { A: '2' });
  assert.strictEqual(second, `alias ll="ls -l"\n\n# TGClaudeBridge\nexport A='2'\n# TGClaudeBridge end\nexport PATH=x\n`);
  assert.strictEqual(upsertEnvBlock('', { A: '1' }), "# TGClaudeBridge\nexport A='1'\n# TGClaudeBridge end\n");
});

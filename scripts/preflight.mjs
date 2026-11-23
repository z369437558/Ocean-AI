// Fails fast with a readable message when the local Node.js is too old for the toolchain.
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;

if (!supported) {
  console.error(
    `\nThis project needs Node.js 20.19+, 22.12+ or newer (found ${process.versions.node}).\n` +
      'Install a current LTS release from https://nodejs.org/ and run the command again.\n',
  );
  process.exit(1);
}

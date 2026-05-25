const fs = require('fs');
const path = require('path');

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyFolderSync(from, to) {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }
  fs.readdirSync(from).forEach(element => {
    const fromPath = path.join(from, element);
    const toPath = path.join(to, element);
    if (fs.lstatSync(fromPath).isDirectory()) {
      copyFolderSync(fromPath, toPath);
    } else {
      if (!element.endsWith('.ts')) {
        fs.copyFileSync(fromPath, toPath);
      }
    }
  });
}

try {
  const distPath = path.join(__dirname, 'dist');
  cleanDir(distPath);
  console.log('✓ Cleaned dist directory');

  const srcPublic = path.join(__dirname, 'public');
  const destPublic = path.join(__dirname, 'dist', 'public');
  if (fs.existsSync(srcPublic)) {
    copyFolderSync(srcPublic, destPublic);
    console.log('✓ Public static assets copied to dist/public');
  } else {
    console.log('⚠ Source public directory not found, skipping static assets copy');
  }
} catch (e) {
  console.error('Error during asset copy:', e);
  process.exit(1);
}

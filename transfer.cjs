const fs = require('fs');
const sourcePath = 'C:\\Users\\hp\\.gemini\\antigravity\\brain\\29d15cfb-be02-4a63-adaa-bf0b9221d412\\interview_logo_icon_1776540179677.png';
const destPath = 'f:\\18-4-26 thehardikvermacom\\hardikverma-main\\public\\images\\work-interviewpro.png';

try {
  fs.copyFileSync(sourcePath, destPath);
  console.log('Image successfully transferred!');
} catch (e) {
  console.error('Error transferring image:', e);
}

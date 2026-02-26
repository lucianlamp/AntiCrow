const http = require('http');

// Generates an array of ports from 9333 to 9350
const ports = Array.from({ length: 18 }, (_, i) => 9333 + i);

ports.forEach(p => {
    http.get(`http://127.0.0.1:${p}/json`, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => console.log(`Port ${p}:`, d.substring(0, 300)));
    }).on('error', () => console.log(`Port ${p}: Connection refused`));
});

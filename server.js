const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); } catch { return fallback; } };
const write = (file, value) => fs.writeFileSync(path.join(DATA, file), JSON.stringify(value, null, 2));
const products = () => read('products.json', []);
const orders = () => read('orders.json', []);
const money = n => `Rs. ${Number(n).toLocaleString('en-PK')}`;

async function sendEmail(to, subject, text) {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS && nodemailer) {
    const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: SMTP_SECURE === 'true', auth: { user: SMTP_USER, pass: SMTP_PASS } });
    await transporter.sendMail({ from: EMAIL_FROM || SMTP_USER, to, subject, text });
    return 'sent';
  }
  console.log(`\n[EMAIL DEMO] To: ${to}\nSubject: ${subject}\n${text}\n`);
  return 'logged-demo';
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function body(req) { return new Promise((resolve, reject) => { let raw=''; req.on('data', c => { raw += c; if (raw.length > 1e6) reject(new Error('Request too large')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } }); }); }
function authorized(req) { return req.headers['x-admin-key'] && req.headers['x-admin-key'] === ADMIN_KEY; }
function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, content) => {
    if (err) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(file);
    const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(content);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/products') {
      let list = products(); const q = (url.searchParams.get('q') || '').toLowerCase(); const category = url.searchParams.get('category') || 'All';
      const min = Number(url.searchParams.get('min') || 0); const max = Number(url.searchParams.get('max') || Infinity); const sort = url.searchParams.get('sort') || 'featured';
      list = list.filter(p => (!q || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q)) && (category === 'All' || p.category === category) && p.price >= min && p.price <= max);
      if (sort === 'price-asc') list.sort((a,b)=>a.price-b.price); if (sort === 'price-desc') list.sort((a,b)=>b.price-a.price); if (sort === 'name') list.sort((a,b)=>a.name.localeCompare(b.name));
      return json(res, 200, { products: list, categories: ['All', ...new Set(products().map(p=>p.category))] });
    }
    if (req.method === 'POST' && url.pathname === '/api/checkout') {
      const input = await body(req);
      if (!input.customer || !input.customer.name || !input.customer.email || !input.customer.phone || !input.customer.address) return json(res, 400, { error: 'Please complete all customer and delivery fields.' });
      if (!/^\S+@\S+\.\S+$/.test(input.customer.email)) return json(res, 400, { error: 'Enter a valid email address.' });
      if (!Array.isArray(input.items) || !input.items.length) return json(res, 400, { error: 'Your cart is empty.' });
      if (!['cod','online'].includes(input.paymentMethod)) return json(res, 400, { error: 'Choose a valid payment method.' });
      const catalog = products(); const cleanItems = [];
      for (const item of input.items) {
        const p = catalog.find(x => x.id === item.id); const qty = Math.floor(Number(item.quantity));
        if (!p || !Number.isFinite(qty) || qty < 1 || qty > 50) return json(res, 400, { error: 'One or more cart items are invalid.' });
        if (qty > p.stock) return json(res, 400, { error: `${p.name} has only ${p.stock} item(s) in stock.` });
        cleanItems.push({ id:p.id, name:p.name, price:p.price, quantity:qty, lineTotal:p.price*qty });
      }
      const total = cleanItems.reduce((s,x)=>s+x.lineTotal,0);
      const order = { id: 'SE-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(), createdAt:new Date().toISOString(), customer:input.customer, items:cleanItems, total, paymentMethod:input.paymentMethod, paymentStatus:input.paymentMethod === 'cod' ? 'Pay on delivery' : 'Pending provider payment', status: input.paymentMethod === 'cod' ? 'Confirmed' : 'Awaiting payment', paymentMode: input.paymentMethod === 'online' ? (process.env.PAYMENT_MODE || 'demo') : null };
      const all = orders(); all.unshift(order); write('orders.json', all);
      const subject = `Order ${order.id} received`;
      const message = `Hello ${order.customer.name},\n\nThank you for your order.\nOrder: ${order.id}\nTotal: ${money(total)}\nPayment: ${order.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Online payment (pending)'}\nStatus: ${order.status}\n\nWe will email you when your order status changes.`;
      try { order.emailDelivery = await sendEmail(order.customer.email, subject, message); write('orders.json', all); } catch (e) { console.error('Email error:', e.message); order.emailDelivery = 'failed'; write('orders.json', all); }
      return json(res, 201, { order: { id:order.id, total, status:order.status, paymentStatus:order.paymentStatus, paymentMode:order.paymentMode, emailDelivery:order.emailDelivery }, message: input.paymentMethod === 'online' ? 'Order created in demo/pending payment mode. Connect a real payment provider before accepting live payments.' : 'Your order has been placed successfully.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized. Provide the admin key.' });
      return json(res, 200, { orders: orders() });
    }
    const statusMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
    if (req.method === 'PATCH' && statusMatch) {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized. Provide the admin key.' });
      const input = await body(req); const allowed = ['Confirmed','Processing','Shipped','Delivered','Cancelled'];
      if (!allowed.includes(input.status)) return json(res, 400, { error: 'Invalid order status.' });
      const all = orders(); const order = all.find(o=>o.id===statusMatch[1]); if (!order) return json(res,404,{error:'Order not found.'});
      order.status = input.status; order.updatedAt = new Date().toISOString(); write('orders.json', all);
      try { order.statusEmailDelivery = await sendEmail(order.customer.email, `Update for order ${order.id}`, `Hello ${order.customer.name},\n\nYour order ${order.id} is now: ${order.status}.\nThank you for shopping with us.`); write('orders.json', all); } catch(e) { order.statusEmailDelivery='failed'; write('orders.json',all); }
      return json(res,200,{order,message:'Order status updated. Email notification attempted.'});
    }
    return serveStatic(req,res);
  } catch (e) { console.error(e); return json(res, 500, { error: e.message || 'Server error' }); }
});
server.listen(PORT, () => console.log(`ShopEase running at http://localhost:${PORT}`));

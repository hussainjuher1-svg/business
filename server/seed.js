/**
 * Daybook demo seed — clearly identified as DEMONSTRATION DATA.
 * Run: npm run db:seed  (from repo root)
 * Creates: demo business + owner + sample customers/inquiries/estimates/appointments/jobs/follow-ups.
 * Demo login: demo@daybook.local / demo1234
 */
const { migrate, get, run, q } = require('./src/db');
const { hashPassword } = require('./src/auth');

migrate();

const DEMO_EMAIL = 'demo@daybook.local';
const DEMO_PASSWORD = 'demo1234';

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function todayPlusTime(days, hour) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

let user = get('SELECT * FROM users WHERE email = ?', [DEMO_EMAIL]);
if (!user) {
  const info = run('INSERT INTO users (email, password_hash, name) VALUES (?,?,?)', [DEMO_EMAIL, hashPassword(DEMO_PASSWORD), 'Demo Owner']);
  user = get('SELECT * FROM users WHERE id = ?', [Number(info.lastInsertRowid)]);
  console.log('[seed] created demo user');
}

let biz = get('SELECT * FROM businesses WHERE name = ?', ['Demo Services Co. (Demo Data)']);
if (!biz) {
  const info = run(
    `INSERT INTO businesses (name, phone, email, address, hours, policies, payment_methods, service_areas, currency, timezone)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      'Demo Services Co. (Demo Data)',
      '+1 (555) 010-2030',
      'hello@demo-services.example',
      '123 Demo Street, Springfield',
      'Mon–Fri 8:00–17:00, Sat 9:00–13:00',
      'Cancellations: please give at least 24 hours notice. Rescheduling is free.',
      'Cash, card, bank transfer',
      'Springfield and surrounding areas',
      'USD',
      'UTC',
    ]
  );
  biz = get('SELECT * FROM businesses WHERE id = ?', [Number(info.lastInsertRowid)]);
  console.log('[seed] created demo business');
}

const existing = get('SELECT id FROM business_memberships WHERE business_id = ? AND user_id = ?', [biz.id, user.id]);
if (!existing) {
  run('INSERT INTO business_memberships (business_id, user_id, role) VALUES (?,?,?)', [biz.id, user.id, 'owner']);
  console.log('[seed] linked demo user as owner');
}

const alreadySeeded = q('SELECT id FROM customers WHERE business_id = ?', [biz.id]).length > 0;
if (alreadySeeded) {
  console.log('[seed] demo data already present — skipping record seeding.');
  process.exit(0);
}

run('INSERT INTO business_services (business_id, name, description) VALUES (?,?,?)', [biz.id, 'General repairs', 'Small repairs and maintenance']);
run('INSERT INTO business_services (business_id, name, description) VALUES (?,?,?)', [biz.id, 'Installations', 'Installation of fixtures and equipment']);
run('INSERT INTO business_services (business_id, name, description) VALUES (?,?,?)', [biz.id, 'Consultation', 'On-site assessment and advice']);

function addCustomer(name, phone, email) {
  const info = run('INSERT INTO customers (business_id, name, phone, email) VALUES (?,?,?,?)', [biz.id, name, phone, email]);
  return Number(info.lastInsertRowid);
}
const c1 = addCustomer('Alice Johnson (Demo)', '+1 555-100-2001', 'alice@example.com');
const c2 = addCustomer('Bob Smith (Demo)', '+1 555-100-2002', 'bob@example.com');

function addInquiry(customerId, contact, phone, email, source, subject, message, status, daysAgo) {
  const created = todayPlus(-daysAgo);
  const info = run(
    `INSERT INTO inquiries (business_id, customer_id, contact_name, phone, email, source, subject, message, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, datetime(?, '-0 days'))`,
    [biz.id, customerId, contact, phone, email, source, subject, message, status, created]
  );
  return Number(info.lastInsertRowid);
}
const i1 = addInquiry(null, 'Carol Davis (Demo)', '+1 555-100-2003', 'carol@example.com', 'website', 'Leaking tap repair', 'Hi, our kitchen tap is leaking and needs repair this week.', 'new', 1);
const i2 = addInquiry(c1, 'Alice Johnson (Demo)', '+1 555-100-2001', 'alice@example.com', 'phone', 'Bathroom fixture installation', 'Looking for a quote to install a new bathroom fixture.', 'needs_response', 2);
addInquiry(c2, 'Bob Smith (Demo)', '+1 555-100-2002', 'bob@example.com', 'referral', 'Annual maintenance', 'Interested in annual maintenance plan.', 'converted', 5);

const e1 = run(
  `INSERT INTO estimates (business_id, customer_id, inquiry_id, title, description, amount, currency, status, issue_date, valid_until, follow_up_date)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [biz.id, c1, i2, 'Bathroom fixture installation', 'Supply and install new fixture, including sealant and testing.', 450, 'USD', 'sent', todayPlus(-3), todayPlus(27), todayPlus(-1)]
);
const e2 = run(
  `INSERT INTO estimates (business_id, customer_id, title, description, amount, currency, status, issue_date, valid_until)
   VALUES (?,?,?,?,?,?,?,?,?)`,
  [biz.id, c2, 'Annual maintenance plan', 'Four scheduled maintenance visits per year.', 1200, 'USD', 'awaiting_response', todayPlus(-2), todayPlus(28)]
);

run(
  `INSERT INTO appointments (business_id, customer_id, title, starts_at, ends_at, location, status)
   VALUES (?,?,?,?,?,?,?)`,
  [biz.id, c1, 'Fixture installation visit', todayPlusTime(0, 10), todayPlusTime(0, 11), 'Customer address', 'confirmation_needed']
);
run(
  `INSERT INTO appointments (business_id, customer_id, title, starts_at, ends_at, location, status)
   VALUES (?,?,?,?,?,?,?)`,
  [biz.id, c2, 'Maintenance inspection', todayPlusTime(1, 9), todayPlusTime(1, 10), 'Customer address', 'scheduled']
);

const j1 = run(
  `INSERT INTO jobs (business_id, customer_id, inquiry_id, estimate_id, title, description, status, scheduled_date)
   VALUES (?,?,?,?,?,?,?,?)`,
  [biz.id, c1, i2, Number(e1.lastInsertRowid), 'Bathroom fixture installation', 'Install new fixture per estimate.', 'scheduled', todayPlus(0)]
);
run(
  `INSERT INTO jobs (business_id, customer_id, title, description, status, scheduled_date)
   VALUES (?,?,?,?,?,?)`,
  [biz.id, c2, 'Tap repair', 'Repair leaking kitchen tap.', 'in_progress', todayPlus(-1)]
);

run(
  `INSERT INTO follow_ups (business_id, customer_id, estimate_id, title, notes, due_date, status)
   VALUES (?,?,?,?,?,?,?)`,
  [biz.id, c1, Number(e1.lastInsertRowid), 'Follow up on fixture estimate', 'Call to check if customer has questions.', todayPlus(-1), 'open']
);
run(
  `INSERT INTO follow_ups (business_id, customer_id, title, notes, due_date, status)
   VALUES (?,?,?,?,?,?)`,
  [biz.id, c2, 'Send maintenance plan details', '', todayPlus(0), 'open']
);

console.log('[seed] demo data created. Login: demo@daybook.local / demo1234');
console.log('[seed] NOTE: all records above are demonstration data, not real customer activity.');
process.exit(0);

-- Seed for a v0.108.0 database, one fresh tenant. Bookings keep contact_id NULL,
-- like data written before every booking had a contact.
INSERT INTO contact (id, tenant_id, name, email, company, status, kind) VALUES
 ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'Acme', 'acme@example.com', '', 'customer', 'company');
INSERT INTO product (id, tenant_id, name, description, reference, unit_price) VALUES
 ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Widget', '', 'PRD-00001', 10);
INSERT INTO product_variant (id, tenant_id, product_id, name, unit_price) VALUES
 ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Default', 10);
INSERT INTO quote (id, tenant_id, number, subject, customer_id, customer_name, customer_email) VALUES
 ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001', 'Q-2026-0001', 'Demo', '00000000-0000-4000-8000-0000000000c1', 'Acme', 'acme@example.com');
INSERT INTO quote_line (id, tenant_id, quote_id, variant_id, variant_name, quantity, unit, tax_rate, unit_price) VALUES
 ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000b1', 'Default', 2, 'u', 0.2, 10);
INSERT INTO event (id, tenant_id, name, kind, timezone, published) VALUES
 ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', 'Open day', 'sessions', 'Europe/Paris', true);
INSERT INTO event_session (id, tenant_id, event_id, starts_at, ends_at, capacity, seats_taken) VALUES
 ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '2026-12-01 10:00+00', '2026-12-01 11:00+00', 10, 3);
INSERT INTO event_booking (id, tenant_id, event_id, session_id, seats, email, name, status, starts_at) VALUES
 ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2', 3, 'visitor@example.com', 'Visitor', 'confirmed', '2026-12-01 10:00+00');
INSERT INTO website_page (id, tenant_id, slug, title, published) VALUES
 ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000001', 'about', 'About', true);

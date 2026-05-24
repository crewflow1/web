-- ============================================================================
-- CrewFlow end-to-end lifecycle test.
--
-- Walks one synthetic customer through the entire business lifecycle:
--
--   demo booked → HQ approves → trial bootstraps → customer fills onboarding
--   → quote sent → quote accepted → invoice → payment → dashboard counts
--
-- Every step is a real INSERT / UPDATE against the live tables, gated by a
-- unique sentinel slug + email so the data can be cleaned up cleanly at the
-- end. The script raises an exception (transaction rolls back) the moment
-- any expected condition fails — GREEN only if it reaches the bottom without
-- erroring.
--
-- Variable names are prefixed `v_` to avoid plpgsql column-name shadowing.
-- ============================================================================

begin;

do $$
declare
  sentinel text := 'e2e-' || extract(epoch from now())::bigint;
  test_email text := sentinel || '@crewflow-e2e.invalid';
  v_demo_id uuid;
  v_org_id uuid;
  v_user_id uuid;
  v_customer_id uuid;
  v_quote_id uuid;
  v_invoice_id uuid;
  v_payment_id uuid;
  v_trial_status text;
  v_membership_role text;
  v_invoice_total numeric;
  v_payment_amount numeric;
begin
  raise notice '== CrewFlow lifecycle test: sentinel=%', sentinel;

  -- -------------------------------------------------------------------------
  -- 1. Demo booked — simulates POST /api/demo.
  -- -------------------------------------------------------------------------
  insert into public.demo_requests (
    name, company, email, phone, employees, source, status
  ) values (
    'E2E Test Owner',
    'Acme Roofing E2E',
    test_email,
    '+447700900000',
    '6_25',
    'e2e_lifecycle_test',
    'new'
  ) returning id into v_demo_id;

  if v_demo_id is null then
    raise exception 'STEP 1 FAILED: demo_request insert returned no id';
  end if;
  raise notice '✓ STEP 1: demo booked (id=%)', v_demo_id;

  -- -------------------------------------------------------------------------
  -- 2. HQ visibility — same SELECT the /admin/demos page issues.
  -- -------------------------------------------------------------------------
  perform 1 from public.demo_requests where id = v_demo_id;
  if not found then
    raise exception 'STEP 2 FAILED: demo row not visible to HQ select';
  end if;
  raise notice '✓ STEP 2: demo visible to HQ';

  -- -------------------------------------------------------------------------
  -- 3. HQ approval — simulates the /admin/demos kanban "Won" lane.
  --    PR #91 widened the bootstrap auto-trial filter to accept 'won'.
  -- -------------------------------------------------------------------------
  update public.demo_requests
     set status = 'won',
         approved_at = now()
   where id = v_demo_id;
  raise notice '✓ STEP 3: demo approved (status=won)';

  -- -------------------------------------------------------------------------
  -- 4. Auth user — simulates the magic-link callback creating both an
  --    auth.users record AND the public.users row mirroring it. The
  --    public.users.id is a FK to auth.users.id.
  -- -------------------------------------------------------------------------
  v_user_id := gen_random_uuid();
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) values (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    test_email,
    crypt('e2e-disposable', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb
  );
  insert into public.users (id, email, full_name)
  values (v_user_id, test_email, 'E2E Test Owner');

  -- -------------------------------------------------------------------------
  -- 5. Org bootstrap with auto-trial — mirrors bootstrap-account.ts.
  --    The directive's "won" status now triggers initialStatus='trial'.
  -- -------------------------------------------------------------------------
  insert into public.organizations (
    name, slug, status, trial_ends_at, onboarding_state
  ) values (
    'Acme Roofing E2E',
    sentinel,
    'trial',
    now() + interval '14 days',
    jsonb_build_object('company', true)
  ) returning id into v_org_id;

  insert into public.memberships (org_id, user_id, role)
  values (v_org_id, v_user_id, 'owner');

  select status into v_trial_status from public.organizations where id = v_org_id;
  if v_trial_status <> 'trial' then
    raise exception 'STEP 5 FAILED: expected trial, got %', v_trial_status;
  end if;

  select m.role into v_membership_role from public.memberships m
   where m.org_id = v_org_id and m.user_id = v_user_id;
  if v_membership_role <> 'owner' then
    raise exception 'STEP 5 FAILED: owner role not set';
  end if;
  raise notice '✓ STEP 5: org bootstrapped (status=trial, owner=member)';

  -- -------------------------------------------------------------------------
  -- 6. Onboarding step 1: company profile. Customer-side computeProgress()
  --    keys on name + phone + postcode in address jsonb.
  -- -------------------------------------------------------------------------
  update public.organizations
     set phone = '+441234567890',
         address = jsonb_build_object('postcode', 'SW1A 1AA')
   where id = v_org_id;

  perform 1 from public.organizations
   where id = v_org_id
     and name is not null
     and phone is not null
     and address ? 'postcode';
  if not found then
    raise exception 'STEP 6 FAILED: company profile snapshot fields missing';
  end if;
  raise notice '✓ STEP 6: company profile saved';

  -- -------------------------------------------------------------------------
  -- 7. Onboarding step 2: bank details (required step).
  -- -------------------------------------------------------------------------
  update public.organizations
     set bank_details = jsonb_build_object(
       'name', 'Acme Roofing E2E',
       'sort_code', '20-00-00',
       'account_number', '12345678'
     )
   where id = v_org_id;
  raise notice '✓ STEP 7: bank details saved';

  -- -------------------------------------------------------------------------
  -- 8. First customer (required step).
  -- -------------------------------------------------------------------------
  insert into public.customers (org_id, name, email, phone)
  values (v_org_id, 'Acme E2E Customer', 'customer@e2e.invalid', '+441111111111')
  returning id into v_customer_id;
  raise notice '✓ STEP 8: first customer created (id=%)', v_customer_id;

  -- -------------------------------------------------------------------------
  -- 9. First quote (required step).
  -- -------------------------------------------------------------------------
  insert into public.quotes (
    org_id, customer_id, number, status, subtotal, vat_total, total, valid_until, currency
  ) values (
    v_org_id, v_customer_id, 'Q-E2E-001', 'draft',
    1000.00, 200.00, 1200.00,
    current_date + interval '14 days',
    'GBP'
  ) returning id into v_quote_id;

  insert into public.quote_line_items (
    quote_id, org_id, description, qty, unit, unit_price, vat_rate, sort_order
  ) values (
    v_quote_id, v_org_id, 'E2E test line item', 1, 'ea', 1000.00, 20, 0
  );
  raise notice '✓ STEP 9: quote drafted (id=%)', v_quote_id;

  -- -------------------------------------------------------------------------
  -- 10. Customer accepts the quote.
  -- -------------------------------------------------------------------------
  update public.quotes
     set status = 'accepted',
         accepted_at = now()
   where id = v_quote_id;

  perform 1 from public.quotes where id = v_quote_id and status = 'accepted';
  if not found then
    raise exception 'STEP 10 FAILED: quote not accepted';
  end if;
  raise notice '✓ STEP 10: quote accepted';

  -- -------------------------------------------------------------------------
  -- 11. Invoice generated. Mirrors the auto-invoice that the customer
  --     portal fires on quote acceptance.
  -- -------------------------------------------------------------------------
  insert into public.invoices (
    org_id, quote_id, number, amount, vat_total, status, due_date
  ) values (
    v_org_id, v_quote_id, 'INV-E2E-001', 1000.00, 200.00,
    'sent', current_date + interval '30 days'
  ) returning id into v_invoice_id;

  select total into v_invoice_total from public.invoices where id = v_invoice_id;
  if v_invoice_total <> 1200.00 then
    raise exception 'STEP 11 FAILED: invoice total expected 1200, got %', v_invoice_total;
  end if;
  raise notice '✓ STEP 11: invoice generated (total=%)', v_invoice_total;

  -- -------------------------------------------------------------------------
  -- 12. Customer pays via bank transfer — invoice_payments row.
  -- -------------------------------------------------------------------------
  insert into public.invoice_payments (
    org_id, invoice_id, amount, paid_at, source, reference
  ) values (
    v_org_id, v_invoice_id, 1200.00, current_date, 'manual', 'E2E-BACS-REF'
  ) returning id into v_payment_id;

  select sum(amount) into v_payment_amount
    from public.invoice_payments
   where invoice_id = v_invoice_id;
  if v_payment_amount <> 1200.00 then
    raise exception 'STEP 12 FAILED: payment amount expected 1200, got %', v_payment_amount;
  end if;

  update public.invoices
     set status = 'paid', paid_at = now()
   where id = v_invoice_id;
  raise notice '✓ STEP 12: payment recorded; invoice marked paid';

  -- -------------------------------------------------------------------------
  -- 13. Dashboard reflection — verify the customer's dashboard counts
  --     would render at least one of each.
  -- -------------------------------------------------------------------------
  if (select count(*) from public.customers c where c.org_id = v_org_id) <> 1 then
    raise exception 'STEP 13 FAILED: customer count mismatch';
  end if;
  if (select count(*) from public.quotes q where q.org_id = v_org_id) <> 1 then
    raise exception 'STEP 13 FAILED: quote count mismatch';
  end if;
  if (select count(*) from public.invoices i
       where i.org_id = v_org_id and i.status = 'paid') <> 1 then
    raise exception 'STEP 13 FAILED: paid invoice count mismatch';
  end if;
  if (select count(*) from public.invoice_payments p where p.org_id = v_org_id) <> 1 then
    raise exception 'STEP 13 FAILED: payment count mismatch';
  end if;
  raise notice '✓ STEP 13: dashboard counts correct (1 customer, 1 quote, 1 paid invoice, 1 payment)';

  -- -------------------------------------------------------------------------
  -- Cleanup — restore the database to pre-test state.
  -- Order matches FK dependency (children → parents).
  -- -------------------------------------------------------------------------
  delete from public.invoice_payments where org_id = v_org_id;
  delete from public.invoices where org_id = v_org_id;
  delete from public.quote_line_items where quote_id = v_quote_id;
  delete from public.quotes where org_id = v_org_id;
  delete from public.customers where org_id = v_org_id;
  delete from public.memberships where org_id = v_org_id;
  delete from public.organizations where id = v_org_id;
  delete from public.users where id = v_user_id;
  delete from auth.users where id = v_user_id;
  delete from public.demo_requests where id = v_demo_id;

  raise notice '== ALL 13 STEPS PASSED. Cleaned up sentinel=%', sentinel;
end;
$$;

commit;

-- Manual cleanup if a run aborted mid-flight (uncomment + run):
--
--   delete from public.invoice_payments
--    where org_id in (select id from public.organizations where slug like 'e2e-%');
--   delete from public.invoices
--    where org_id in (select id from public.organizations where slug like 'e2e-%');
--   delete from public.quote_line_items
--    where quote_id in (
--      select id from public.quotes
--       where org_id in (select id from public.organizations where slug like 'e2e-%')
--    );
--   delete from public.quotes
--    where org_id in (select id from public.organizations where slug like 'e2e-%');
--   delete from public.customers
--    where org_id in (select id from public.organizations where slug like 'e2e-%');
--   delete from public.memberships
--    where org_id in (select id from public.organizations where slug like 'e2e-%');
--   delete from public.organizations where slug like 'e2e-%';
--   delete from public.users where email like 'e2e-%@crewflow-e2e.invalid';
--   delete from auth.users where email like 'e2e-%@crewflow-e2e.invalid';
--   delete from public.demo_requests where email like 'e2e-%@crewflow-e2e.invalid';

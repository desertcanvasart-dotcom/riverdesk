-- Manager: runs the company's day-to-day setup (fleet, schedule, rates, channels) on top of
-- what reservations does, without company settings, staff, guest privacy or money.
alter table vs.staff_user drop constraint staff_user_role_check;
alter table vs.staff_user add constraint staff_user_role_check
  check (role in ('owner', 'manager', 'reservations', 'finance', 'read_only', 'onboard'));

alter table vs.staff_invitation drop constraint staff_invitation_role_check;
alter table vs.staff_invitation add constraint staff_invitation_role_check
  check (role in ('owner', 'manager', 'reservations', 'finance', 'read_only', 'onboard'));

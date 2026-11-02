-- Guest erasure: folio charges never change (the back office cannot update them), except that a
-- guest's name written on a charge can be blanked when that guest is erased. Only within the
-- caller's company, only on the named booking, only where the name is exactly the guest's.
create function vs.erase_folio_guest_name(p_booking_id uuid, p_name text)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update vs.folio_charge c set guest_name = null
  from vs.folio f
  where f.id = c.folio_id and f.booking_id = p_booking_id
    and f.operator_id = vs.current_operator_id() and c.operator_id = vs.current_operator_id()
    and c.guest_name = p_name;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function vs.erase_folio_guest_name(uuid, text) from public, vs_api, vs_worker;

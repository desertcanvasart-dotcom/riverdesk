import { z } from 'zod';
import { bookingDocumentHtml, sampleBooking } from '@vs/documents';
import {
  documentBrand,
  getBranding,
  setLogo,
  setLogoInput,
  updateBranding,
  updateBrandingInput,
  addMarket,
  addMarketInput,
  deleteMarket,
  listMarkets,
  updateMarket,
  updateMarketInput,
  getOperatorSettings,
  inviteStaff,
  inviteStaffInput,
  listStaff,
  revokeInvitation,
  revokeInvitationInput,
  updateOperatorSettings,
  updateOperatorSettingsInput,
  updateStaff,
  updateStaffInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

/** The Branding screen's preview: the draft colours and contact block, the saved logo. */
const previewInput = updateBrandingInput.extend({ locale: z.enum(['ar', 'en', 'both']) });

export const settingsRouter = router({
  branding: procedure('read').query(({ ctx }) => getBranding(backofficeDb(), ctx.engine)),
  updateBranding: procedure('settings.write')
    .input(updateBrandingInput)
    .mutation(({ ctx, input }) => updateBranding(backofficeDb(), ctx.engine, input)),
  setLogo: procedure('settings.write')
    .input(setLogoInput)
    .mutation(({ ctx, input }) => setLogo(backofficeDb(), ctx.engine, input)),
  /** A sample voucher (made-up guests) in the draft brand, as HTML for a sandboxed frame. */
  brandingPreview: procedure('read')
    .input(previewInput)
    .query(async ({ ctx, input }) => {
      const saved = await documentBrand(backofficeDb(), ctx.engine);
      const draft = previewInput.parse(input);
      const brand = {
        ...saved,
        primary: draft.primaryColor || saved.primary,
        secondary: draft.secondaryColor || saved.secondary,
        contact: {
          phone: draft.phone ?? null,
          whatsapp: draft.whatsapp ?? null,
          email: draft.email ?? null,
          website: draft.website ?? null,
          address: { ar: draft.addressAr ?? '', en: draft.addressEn ?? '' },
        },
      };
      return bookingDocumentHtml('voucher', sampleBooking(saved.name), input.locale, false, brand);
    }),
  /** The company's markets: every screen that names a market reads them (markets, 2026-10-24). */
  markets: procedure('read').query(({ ctx }) => listMarkets(backofficeDb(), ctx.engine)),
  addMarket: procedure('settings.write')
    .input(addMarketInput)
    .mutation(({ ctx, input }) => addMarket(backofficeDb(), ctx.engine, input)),
  updateMarket: procedure('settings.write')
    .input(updateMarketInput)
    .mutation(({ ctx, input }) => updateMarket(backofficeDb(), ctx.engine, input)),
  deleteMarket: procedure('settings.write')
    .input(z.object({ marketId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteMarket(backofficeDb(), ctx.engine, input.marketId)),
  staff: procedure('read').query(({ ctx }) => listStaff(backofficeDb(), ctx.engine)),
  invite: procedure('settings.write')
    .input(inviteStaffInput)
    .mutation(({ ctx, input }) => inviteStaff(backofficeDb(), ctx.engine, input)),
  revokeInvitation: procedure('settings.write')
    .input(revokeInvitationInput)
    .mutation(({ ctx, input }) => revokeInvitation(backofficeDb(), ctx.engine, input)),
  updateStaff: procedure('settings.write')
    .input(updateStaffInput)
    .mutation(({ ctx, input }) => updateStaff(backofficeDb(), ctx.engine, input)),
  operator: procedure('read').query(({ ctx }) => getOperatorSettings(backofficeDb(), ctx.engine)),
  updateOperator: procedure('settings.write')
    .input(updateOperatorSettingsInput)
    .mutation(({ ctx, input }) => updateOperatorSettings(backofficeDb(), ctx.engine, input)),
});

import React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer id="club-info" className="w-full bg-[#5E2CB2] text-[#B3A2DB] py-12 sm:py-16 border-t border-[#B3A2DB]/30">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start justify-between">
          
          {/* Left: Brand Description & Copyright */}
          <div className="md:col-span-7 flex flex-col gap-4">
            <div className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#00C6FF] shadow-sm shadow-[#00C6FF]/60" />
              <span className="font-heading text-xl sm:text-2xl font-black tracking-tight text-[#FFFFFF] uppercase">
                MATCH&amp;SIP
              </span>
            </div>

            <p className="max-w-md text-xs sm:text-sm text-[#B3A2DB] leading-relaxed font-normal">
              A chill destination for pickleball, where you can have a MATCH while enjoying a SIP of coffee. See you!
            </p>

            <span className="text-xs text-[#B3A2DB]/80 font-medium pt-2">
              © 2026 MATCH&amp;SIP. Play the lines.
            </span>
          </div>

          {/* Right: Contact, Social & Address */}
          <div className="md:col-span-5 flex flex-col gap-3 text-left md:text-right">
            <a
              href="tel:+639666919170"
              className="text-xs sm:text-sm font-bold text-[#FFFFFF] hover:text-[#00C6FF] transition-colors"
            >
              +63 966-691-9170
            </a>

            <div className="text-xs sm:text-sm text-[#B3A2DB]">
              <a
                href="mailto:matchandsip@gmail.com"
                className="hover:text-[#00C6FF] text-[#FFFFFF] transition-colors"
              >
                matchandsip@gmail.com
              </a>
              <span className="mx-1.5 text-[#B3A2DB]">/</span>
              <a
                href="https://instagram.com"
                target="_blank"
                rel="noreferrer"
                className="hover:text-[#00C6FF] text-[#FFFFFF] transition-colors"
              >
                matchsip on instagram
              </a>
            </div>

            <p className="text-xs text-[#B3A2DB] leading-relaxed">
              Purok 19, Promise Land, Brgy. Mabuhay, G.S.C.
            </p>
          </div>

        </div>
      </div>
    </footer>
  );
};

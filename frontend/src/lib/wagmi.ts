import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { SUPPORTED_CHAINS } from "./chains";

export const wagmiConfig = createConfig({
  chains: SUPPORTED_CHAINS,
  connectors: [injected()],
  transports: {
    [SUPPORTED_CHAINS[0].id]: http(),
    [SUPPORTED_CHAINS[1].id]: http(),
  },
  ssr: true,
});

export const providerDirectory: Record<string, string> = {
	"0U~8qaluNm4nlBHS1lX4Sg==": "Yully Gonzalez",
    "VJYp1jmJ990M8rSgmEKuCg==": "Leidy Villasmil",
    "ygttmkB0kqajnP3G9VFFCA==": "Elizabeth Rodriguez",
    "HQVVjyfx2LMBmjykVMp4uA==": "Liz Gutierrez",
};

export function lookupProviderName(providerId: string): string | undefined {
	return providerDirectory[providerId];
}

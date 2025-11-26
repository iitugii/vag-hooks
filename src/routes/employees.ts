export const providerDirectory: Record<string, string> = {
	"0U~8qaluNm4nlBHS1lX4Sg==": "Yully Gonzalez",
    "VJYp1jmJ990M8rSgmEKuCg==": "Leidy Villasmil",
    "ygttmkB0kqajnP3G9VFFCA==": "Elizabeth Rodriguez",
    "HQVVjyfx2LMBmjykVMp4uA==": "Liz Gutierrez",
    "G~vAH-ywuaMTU8U-mQSPSw==": "Alexandra Rumbo",
    "iGdlKrBiZNl~zAXcKYHAtg==": "Anaisleidys Olivert",
    "lLHKiHNGeN0d-CmqhnUIzg==": "Kenia Fernandez",
    "qloWTWPGZbaXLm62UEZezw==": "Ghislaine Rodriguez",
    "RL~9TokljBGmTZJrF~OONQ==": "Isabel Guerrero",
    "u41~oI~Elac3QmDg0IE3LQ==": "Marielbys Miranda",
    "DYOsnZF92isbHl0aVQtB5w==": "Alex Santiesteban",
    "RgW1Yi3geC8oYpX-jPt1xg==": "Mary Betandcourt",
    "XYSdsoZNLpg~vz42OYwQPg==": "Giselle Navarro",
    "hWJIChYtRdsuqlnAeIpqfA==": "Annelys Garcia",
    "QAAiKbzzli94LGrnJ3GX0Q==": "Yessika Delgado",
    "8m0Pi9tJgReoyUxrRqq-Nw==": "Fany Colome",
    "1f0-pADxzjo5oCJfQvqwEg==": "Elianys Vigoa",
    "cOuMhKYYXwez7hlBoLpnPg==": "Lily S",






};

export function lookupProviderName(providerId: string): string | undefined {
	return providerDirectory[providerId];
}

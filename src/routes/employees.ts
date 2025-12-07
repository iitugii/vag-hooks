export type ProviderDirectory = Record<string, string>;

export const providerDirectory: ProviderDirectory = {
    "0U~8qaluNm4nlBHS1lX4Sg==": "Yully Gonzalez",
    "VJYp1jmJ990M8rSgmEKuCg==": "Leidy Villasmil",
    "ygttmkB0kqajnP3G9VFFCA==": "Elizabeth Rodriguez",
    "HQVVjyfx2LMBmjykVMp4uA==": "Liz Gutierrez",
    "G~vAH-ywuaMTU8U-mQSPSw==": "Alexandra Rumbo",
    "iGdlKrBiZNl~zAXcKYHAtg==": "Anaisleidys Olivert",
    "lLHKiHNGeN0d-CmqhnUIzg==": "Kenia Fernandez",
    "qloWTWPGZbaXLm62UEZezw==": "Ghislaine Rodriguez",
    "RL~9TokljBGmTZJrF~OONQ==": "Marielbys Miranda",
    "u41~oI~Elac3QmDg0IE3LQ==": "Isabel Guerrero",
    "DYOsnZF92isbHl0aVQtB5w==": "Alex Santiesteban",
    "RgW1Yi3geC8oYpX-jPt1xg==": "Mary Betandcourt",
    "XYSdsoZNLpg~vz42OYwQPg==": "Giselle Navarro",
    "hWJIChYtRdsuqlnAeIpqfA==": "Annelys Garcia",
    "QAAiKbzzli94LGrnJ3GX0Q==": "Yessika Delgado",
    "8m0Pi9tJgReoyUxrRqq-Nw==": "Fany Colome",
    "1f0-pADxzjo5oCJfQvqwEg==": "Elianys Vigoa",
    "cOuMhKYYXwez7hlBoLpnPg==": "Lily S",
    "2~XMU4-eycP4LHBPEzpyVQ==": "Orianna Taborda"
};

export const providerServicePercentages: Record<string, number> = {
    "0U~8qaluNm4nlBHS1lX4Sg==": 50,
    "2~XMU4-eycP4LHBPEzpyVQ==": 45,
    "DYOsnZF92isbHl0aVQtB5w==": 45,
    "hWJIChYtRdsuqlnAeIpqfA==": 50,
    "HQVVjyfx2LMBmjykVMp4uA==": 50,
    "RgW1Yi3geC8oYpX-jPt1xg==": 50,
    "G~vAH-ywuaMTU8U-mQSPSw==": 45,
    "RL~9TokljBGmTZJrF~OONQ==": 45,
    "VJYp1jmJ990M8rSgmEKuCg==": 45,
    "QAAiKbzzli94LGrnJ3GX0Q==": 50,
    "ygttmkB0kqajnP3G9VFFCA==": 45,
    "u41~oI~Elac3QmDg0IE3LQ==": 50,
    "1f0-pADxzjo5oCJfQvqwEg==": 45,
    "XYSdsoZNLpg~vz42OYwQPg==": 50,
    "qloWTWPGZbaXLm62UEZezw==": 50,
    "8m0Pi9tJgReoyUxrRqq-Nw==": 45,
    "iGdlKrBiZNl~zAXcKYHAtg==": 45,
    "lLHKiHNGeN0d-CmqhnUIzg==": 45,
    "cOuMhKYYXwez7hlBoLpnPg==": 45
};

export function lookupProviderName(providerId: string): string | undefined {
    return providerDirectory[providerId];
}

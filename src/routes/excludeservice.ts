export const excludedServices = [
	"Nail Art - Tier 1",
	"Childrens Manicure",
	"Childrens Pedicure",
	"Soak Off",
    "Nail Replacement",
] as const;

export const excludedServiceSet = new Set(
	excludedServices.map(service => service.toLowerCase())
);
//! Wapper type for shared metadata between XMP Metadata and the `DocumentInfo` dictionary

use crate::OffsetDateTime;
use crate::{DocumentInfo, IccProfile, IccProfileType, PdfConformance, XmpMetadata};
use lopdf;

use crate::glob_defines::ICC_PROFILE_ECI_V2;

/// Human-readable description of the printing condition, written into the
/// `/OutputIntents` dictionary on save (together with the embedded ICC profile).
/// The default describes Coated FOGRA39, matching the default ECI CMYK profile.
#[derive(Debug, Clone)]
pub struct OutputIntentDescription {
    /// Concise, human-readable name of the printing condition (`/OutputConditionIdentifier`).
    /// Use a registered identifier (e.g. "FOGRA39") or "Custom".
    pub output_condition_identifier: String,
    /// Longer description of the intended printing condition (`/OutputCondition`).
    pub output_condition: String,
    /// Registry the identifier belongs to (`/RegistryName`), e.g. "http://www.color.org".
    /// Omitted from the PDF when `None` (required for "Custom" identifiers).
    pub registry_name: Option<String>,
    /// Human-readable description of the embedded destination profile (`/Info`).
    pub info: String,
}

impl Default for OutputIntentDescription {
    fn default() -> Self {
        OutputIntentDescription {
            output_condition_identifier: "FOGRA39".into(),
            output_condition: "Commercial and special offset print acccording to ISO \
                               12647-2:2004 / Amd 1, paper type 1 or 2 (matte or gloss-coated \
                               offset paper, 115 g/m2), screen ruling 60/cm"
                .into(),
            registry_name: Some("http://www.color.org".into()),
            info: "Coated FOGRA39 (ISO 12647-2:2004)".into(),
        }
    }
}

/// This is a wrapper in order to keep shared data between the documents XMP metadata and
/// the "Info" dictionary in sync
#[derive(Debug, Clone)]
pub struct PdfMetadata {
    /// Creation date of the document
    pub creation_date: OffsetDateTime,
    /// Modification date of the document
    pub modification_date: OffsetDateTime,
    /// Creation date of the metadata
    pub metadata_date: OffsetDateTime,
    /// PDF document title
    pub document_title: String,
    /// PDF document author
    pub author: String,
    /// The creator of the document
    pub creator: String,
    /// The producer of the document
    pub producer: String,
    /// Keywords associated with the document
    pub keywords: Vec<String>,
    /// The subject of the document
    pub subject: String,
    /// Identifier associated with the document
    pub identifier: String,
    /// Is the document trapped?
    pub trapping: bool,
    /// PDF document version
    pub document_version: u32,
    /// PDF Standard
    pub conformance: PdfConformance,
    /// XMP Metadata. Is ignored on save if the PDF conformance does not allow XMP
    pub xmp_metadata: XmpMetadata,
    /// PDF Info dictionary. Contains metadata for this document
    pub document_info: DocumentInfo,
    /// Target color profile
    pub target_icc_profile: Option<IccProfile>,
    /// Description of the printing condition written to `/OutputIntents`.
    pub output_intent: OutputIntentDescription,
}

impl PdfMetadata {
    /// Creates a new metadata object
    pub fn new<S>(
        title: S,
        document_version: u32,
        trapping: bool,
        conformance: PdfConformance,
    ) -> Self
    where
        S: Into<String>,
    {
        let current_time = OffsetDateTime::now_utc();

        Self {
            creation_date: current_time.clone(),
            modification_date: current_time.clone(),
            metadata_date: current_time,
            document_title: title.into(),
            author: String::new(),
            creator: String::new(),
            producer: String::new(),
            keywords: Vec::new(),
            subject: String::new(),
            identifier: String::new(),
            trapping,
            document_version,
            conformance,
            xmp_metadata: XmpMetadata::new(Some("default".into()), 1),
            document_info: DocumentInfo::new(),
            target_icc_profile: None,
            output_intent: OutputIntentDescription::default(),
        }
    }

    /// Consumes the metadata, returning the (Option<xmp_metadata>, document_info, icc_profile_stream).
    pub fn into_obj(self) -> (Option<lopdf::Object>, lopdf::Object, Option<IccProfile>) {
        let metadata = self.clone();
        let xmp_obj = {
            if self.conformance.must_have_xmp_metadata() {
                Some(self.xmp_metadata.into_obj(&metadata))
            } else {
                None
            }
        };

        let doc_info_obj = self.document_info.into_obj(&metadata);
        // add icc profile if necessary
        let icc_profile = {
            if self.conformance.must_have_icc_profile() {
                match self.target_icc_profile {
                    Some(icc) => Some(icc),
                    None => Some(
                        IccProfile::new(ICC_PROFILE_ECI_V2.to_vec(), IccProfileType::Cmyk)
                            .with_alternate_profile(false)
                            .with_range(true),
                    ),
                }
            } else {
                None
            }
        };

        (xmp_obj, doc_info_obj, icc_profile)
    }
}

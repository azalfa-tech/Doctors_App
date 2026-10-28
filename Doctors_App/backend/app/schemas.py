from pydantic import BaseModel, Field
from typing import List, Optional

class PatientDetails(BaseModel):
    name: Optional[str] = None
    age: Optional[str] = None
    sex: Optional[str] = None

class HPI(BaseModel):
    onset: Optional[str] = None
    duration: Optional[str] = None
    progression: Optional[str] = None
    aggravating_factors: List[str] = Field(default_factory=list)
    relieving_factors: List[str] = Field(default_factory=list)
    narrative: Optional[str] = None

class Symptoms(BaseModel):
    positives: List[str] = Field(default_factory=list)
    stated_negatives: List[str] = Field(default_factory=list)

class Medication(BaseModel):
    name: str
    dose: Optional[str] = None
    frequency: Optional[str] = None
    adherence: Optional[str] = None
    notes: Optional[str] = None

class Observations(BaseModel):
    vitals: List[str] = Field(default_factory=list)
    examination_findings: List[str] = Field(default_factory=list)

class Assessment(BaseModel):
    provisional_diagnosis: Optional[str] = None
    differentials: List[str] = Field(default_factory=list)
    clinician_stated_reasoning: Optional[str] = None

class Plan(BaseModel):
    investigations: List[str] = Field(default_factory=list)
    prescriptions: List[str] = Field(default_factory=list)
    advice: List[str] = Field(default_factory=list)
    follow_up: List[str] = Field(default_factory=list)

class ClinicalNote(BaseModel):
    patient_details: PatientDetails = Field(default_factory=PatientDetails)
    chief_complaint: Optional[str] = None
    history_of_present_illness: HPI = Field(default_factory=HPI)
    symptoms: Symptoms = Field(default_factory=Symptoms)
    past_medical_history: List[str] = Field(default_factory=list)
    medication_history: List[Medication] = Field(default_factory=list)
    known_allergies: List[str] = Field(default_factory=list)
    clinical_observations: Observations = Field(default_factory=Observations)
    assessment: Assessment = Field(default_factory=Assessment)
    plan: Plan = Field(default_factory=Plan)
    uncertainties_or_conflicts: List[str] = Field(default_factory=list)
    items_for_clinician_review: List[str] = Field(default_factory=list)
    concise_summary: Optional[str] = None

class AnalyzeRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=100_000)

class AnalyzeResponse(BaseModel):
    note: ClinicalNote
    model: str
    disclaimer: str = "AI-generated draft. A qualified clinician must verify every field before clinical use."

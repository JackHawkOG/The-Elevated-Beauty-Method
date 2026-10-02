import { useState } from "react";
import { Link, useLocation } from "wouter";
import { AppLayout } from "@/components/layout";
import { 
  useListCourses, 
  getListCoursesQueryKey,
  useListCategories,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Library, BookOpen, Users, ChevronRight, Loader2, Lock, Unlock, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useCourseEnrollment, enrollmentErrorNotice } from "@/hooks/use-course-enrollment";

export default function CoursesPage() {
  const [search, setSearch] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | undefined>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: categories, isLoading: categoriesLoading } = useListCategories();
  
  const courseParams = { search: search || undefined, categoryId: selectedCategoryId };
  const { data: courses, isLoading: coursesLoading } = useListCourses(
    courseParams,
    { query: { queryKey: getListCoursesQueryKey(courseParams) } }
  );

  const enrollMutation = useCourseEnrollment((data) => {
    toast({ title: "Enrolled successfully", description: `You are now enrolled in ${data.courseTitle}.` });
    setLocation(`/courses/${data.courseId}`);
  });

  const handleEnroll = (courseId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    enrollMutation.mutate({ data: { courseId } }, {
      onError: (error) => toast(enrollmentErrorNotice(error)),
    });
  };

  return (
    <AppLayout>
      <div className="space-y-12 pb-16 max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-4xl md:text-5xl font-serif font-bold text-foreground tracking-tight mb-3">The Library</h1>
            <p className="text-muted-foreground text-lg max-w-2xl">Beauty mastery, confidence, and presence — explore every pathway and discover your next step.</p>
          </div>
          <div className="relative w-full md:w-80">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              type="search" 
              placeholder="Search pathways..."
              className="pl-11 h-12 bg-card border-border rounded-full shadow-sm focus-visible:ring-primary/50"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Category Filter */}
        <div>
          {categoriesLoading ? (
            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-10 w-28 rounded-full bg-muted shrink-0" />)}
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Badge 
                variant={selectedCategoryId === undefined ? "default" : "outline"} 
                className={`cursor-pointer rounded-full px-5 py-2 text-sm font-medium transition-colors ${selectedCategoryId === undefined ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-md' : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/50 bg-card'}`}
                onClick={() => setSelectedCategoryId(undefined)}
              >
                All Topics
              </Badge>
              {categories?.map(cat => (
                <Badge 
                  key={cat.id} 
                  variant={selectedCategoryId === cat.id ? "default" : "outline"}
                  className={`cursor-pointer rounded-full px-5 py-2 text-sm font-medium transition-colors ${selectedCategoryId === cat.id ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-md' : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/50 bg-card'}`}
                  onClick={() => setSelectedCategoryId(cat.id)}
                >
                  {cat.name}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Course Grid */}
        <div>
          {coursesLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <Skeleton key={i} className="h-[420px] w-full rounded-3xl bg-card border border-border" />
              ))}
            </div>
          ) : courses?.length === 0 ? (
            <div className="text-center py-24 border border-dashed border-border rounded-3xl bg-card/20">
              <Library className="w-16 h-16 text-muted-foreground/30 mx-auto mb-6" />
              <h3 className="text-2xl font-serif font-bold mb-3">No pathways found</h3>
              <p className="text-muted-foreground text-lg">Try adjusting your search or category filter.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {courses?.map((course) => {
                const isPremium = course.accessTier === 'Premium';
                const isElevated = course.accessTier === 'Elevated';
                const isFree = course.accessTier === 'Free';
                const hasStory = !!course.transformationStory;

                const cardClasses = `h-full hover:bg-card/80 transition-all duration-300 cursor-pointer border-border group overflow-hidden flex flex-col rounded-3xl hover:border-primary/40 hover:shadow-[0_10px_40px_-15px_rgba(255,224,153,0.15)] bg-card ${hasStory ? 'md:col-span-2 lg:col-span-3 grid grid-cols-1 lg:grid-cols-3' : 'col-span-1'}`;

                return (
                  <Link key={course.id} href={`/courses/${course.id}`} className={cardClasses}>

                    {/* If it has a story, it spans 3 columns on large screens: 1 col for image, 1 for story, 1 for content */}
                    {hasStory ? (
                      <>
                        <div className="h-64 lg:h-full bg-muted relative overflow-hidden lg:col-span-1">
                          {course.thumbnailUrl ? (
                            <img src={course.thumbnailUrl} alt={course.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-in-out" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-primary/5 text-primary/30 group-hover:scale-105 transition-transform duration-700 ease-in-out">
                              <Library className="w-16 h-16" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/20 to-transparent"></div>

                          <Badge className="absolute bottom-4 left-4 bg-primary/20 text-primary border-primary/30 backdrop-blur-md px-3 py-1">
                            {course.categoryName}
                          </Badge>
                        </div>
                        
                        <div className="p-8 lg:col-span-1 border-t lg:border-t-0 lg:border-r border-border/50 flex flex-col justify-center bg-primary/5 relative">
                          <div className="absolute top-4 left-4 text-primary/10">
                            <Sparkles className="w-24 h-24" />
                          </div>
                          <div className="relative z-10">
                            <div className="inline-flex items-center gap-2 text-primary font-medium text-xs tracking-widest uppercase mb-4">
                              Transformation
                            </div>
                            <p className="text-foreground leading-relaxed italic font-serif text-xl">
                              {course.transformationStory}
                            </p>
                          </div>
                        </div>

                        <CardContent className="p-8 lg:col-span-1 flex flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between gap-4 mb-4">
                              {isPremium && <Badge className="bg-primary text-primary-foreground font-medium px-3 py-1"><Lock className="w-3 h-3 mr-1" /> Premium</Badge>}
                              {isElevated && <Badge className="bg-secondary text-secondary-foreground font-medium px-3 py-1"><Lock className="w-3 h-3 mr-1" /> Elevated</Badge>}
                              {isFree && <Badge className="bg-muted text-muted-foreground font-medium px-3 py-1 border-border"><Unlock className="w-3 h-3 mr-1" /> Included</Badge>}
                              <Badge variant="outline" className="border-border text-muted-foreground">
                                {course.difficulty}
                              </Badge>
                            </div>

                            <h3 className="font-serif font-bold text-3xl mb-3 group-hover:text-primary transition-colors leading-tight">
                              {course.title}
                            </h3>
                            <p className="text-muted-foreground text-sm line-clamp-3 mb-6 leading-relaxed">
                              {course.description}
                            </p>
                          </div>

                          <div className="space-y-6">
                            <div className="flex items-center gap-6 text-sm text-muted-foreground font-medium">
                              <div className="flex items-center gap-1.5"><BookOpen className="w-4 h-4 text-primary/70" /> {course.lessonCount} lessons</div>
                              <div className="flex items-center gap-1.5"><Users className="w-4 h-4 text-primary/70" /> {course.enrollmentCount} enrolled</div>
                            </div>

                            <div className="flex items-center justify-between pt-5 border-t border-border/50">
                              <span className="text-sm font-medium text-foreground">{course.instructorName}</span>
                              <Button
                                variant="ghost"
                                className="text-primary hover:text-primary hover:bg-primary/10 rounded-full h-10 px-5 group/btn"
                                onClick={(e) => handleEnroll(course.id, e)}
                                disabled={enrollMutation.isPending}
                              >
                                {enrollMutation.isPending && enrollMutation.variables?.data.courseId === course.id ? (
                                  <Loader2 className="w-5 h-5 animate-spin" />
                                ) : (
                                  <>Access <ChevronRight className="w-4 h-4 ml-1 transition-transform group-hover/btn:translate-x-1" /></>
                                )}
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </>
                    ) : (
                      <>
                        <div className="h-56 bg-muted relative overflow-hidden">
                          {course.thumbnailUrl ? (
                            <img src={course.thumbnailUrl} alt={course.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-in-out" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-primary/5 text-primary/30 group-hover:scale-105 transition-transform duration-700 ease-in-out">
                              <Library className="w-12 h-12" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-transparent to-transparent"></div>

                          <div className="absolute top-4 right-4 flex flex-col gap-2 items-end">
                            {isPremium && <Badge className="bg-primary text-primary-foreground font-medium shadow-lg backdrop-blur-md px-3"><Lock className="w-3 h-3 mr-1" /> Premium</Badge>}
                            {isElevated && <Badge className="bg-secondary text-secondary-foreground font-medium shadow-lg backdrop-blur-md px-3"><Lock className="w-3 h-3 mr-1" /> Elevated</Badge>}
                            {isFree && <Badge className="bg-background/80 text-foreground font-medium border-border shadow-lg backdrop-blur-md px-3"><Unlock className="w-3 h-3 mr-1" /> Included</Badge>}
                          </div>

                          <Badge className="absolute bottom-4 left-4 bg-primary/20 text-primary border-primary/30 backdrop-blur-md px-3 py-1">
                            {course.categoryName}
                          </Badge>
                          <Badge variant="outline" className="absolute bottom-4 right-4 bg-background/80 backdrop-blur-md border-border text-foreground">
                            {course.difficulty}
                          </Badge>
                        </div>
                        <CardContent className="p-6 flex-1 flex flex-col justify-between">
                          <div>
                            <h3 className="font-serif font-bold text-2xl mb-3 group-hover:text-primary transition-colors line-clamp-2 leading-tight">
                              {course.title}
                            </h3>
                            <p className="text-muted-foreground text-sm line-clamp-2 mb-6 leading-relaxed">
                              {course.description}
                            </p>
                          </div>

                          <div className="mt-auto space-y-5">
                            <div className="flex items-center gap-5 text-xs text-muted-foreground font-medium">
                              <div className="flex items-center gap-1.5"><BookOpen className="w-3.5 h-3.5 text-primary/70" /> {course.lessonCount} lessons</div>
                              <div className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-primary/70" /> {course.enrollmentCount}</div>
                            </div>

                            <div className="flex items-center justify-between pt-5 border-t border-border/50">
                              <span className="text-sm font-medium text-foreground">{course.instructorName}</span>
                              <Button
                                variant="ghost"
                                className="text-primary hover:text-primary hover:bg-primary/10 rounded-full h-9 px-4 group/btn"
                                onClick={(e) => handleEnroll(course.id, e)}
                                disabled={enrollMutation.isPending}
                              >
                                {enrollMutation.isPending && enrollMutation.variables?.data.courseId === course.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <>Access <ChevronRight className="w-4 h-4 ml-1 transition-transform group-hover/btn:translate-x-1" /></>
                                )}
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
